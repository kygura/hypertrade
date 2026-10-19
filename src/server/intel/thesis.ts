import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AssetSchema,
  ThesisCheckSchema,
  type IntelEvent,
  type SnapshotRow,
  type Thesis,
  type ThesisCheck,
  type ThesisHistoryEntry,
  type ThesisClaim,
  type ThesisEvidence,
} from "../../shared/intel.js";
import type { AssetCtx } from "../../shared/types.js";
import { claimsJsonSchema, validateLines } from "./claims.js";
import { completeStructured, type LlmDeps, type LlmTrace } from "./llm.js";
import type { Notifier } from "../desk/notify.js";
import { isAdvice, lineVerdict, payloadNumbers } from "./numbers.js";
import { sendIntel } from "./notify.js";
import type { IntelStore } from "./store.js";
import { iso, round } from "./util.js";

// Thesis stress-tester (docs/SPEC.md § Intel I0.16). The strong model only turns
// free text into claims, assumptions, invalidation conditions and "wrong if"
// lines, each claim mapped to one check from the fixed catalog. Code
// evaluates every check against stored data (observations, snapshots, live
// contexts, events) — evaluateCheck is pure — and a recheck never calls the
// model again.

export const THESIS_PROMPT_VERSION = "thesis.v1";
/** A current reading older than this does not decide a check (shown, status unknown). */
export const MAX_READING_AGE_MS = 24 * 3600_000;
const EVENTS_LIMIT = 500;

export interface ThesisDeps {
  store: Pick<IntelStore, "listTheses" | "getThesis" | "insertThesis" | "updateThesis" | "deleteThesis" | "nearestSnapshot" | "listEvents">;
  llm: LlmDeps;
  now(): Date;
  /** Latest point per series (db.ts latestObservations); absent → metric checks stay unknown. */
  observations?(seriesIds: string[]): Promise<Array<{ seriesId: string; ts: Date | string; value: number }>>;
  /** Live Hyperliquid contexts (MarketData.ctxs); preferred over the latest snapshot. */
  ctxs?(): Promise<AssetCtx[]>;
  /** Where "premise no longer holds" goes; absent → no alert. */
  notifier?: Notifier;
  signal?: AbortSignal;
}

export const HISTORY_CAP = 365;

export type CheckStatus = ThesisClaim["status"];
export interface CheckResult {
  status: CheckStatus;
  evidence?: ThesisEvidence;
}

/** Current price/funding/OI for an asset, from a live context or the latest snapshot. */
export interface Reading {
  price: number;
  funding: number | null;
  oiUsd: number | null;
  ts: string;
  source: "live" | "snapshot";
}

/** Everything evaluateCheck reads; built by loadCheckData. */
export interface CheckData {
  now: string;
  observations: Record<string, { value: number; ts: string }>;
  current: Record<string, Reading>;
  /** Snapshot at or before now − h, keyed `${asset}|${h}`. */
  prior: Record<string, SnapshotRow>;
  events: IntelEvent[];
}

const H = 3600_000;
const priorKey = (asset: string, h: number) => `${asset}|${h}`;

function cmp(a: number, op: ">" | ">=" | "<" | "<=", b: number): boolean {
  return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : a <= b;
}

function readingSource(asset: string, r: Reading): ThesisEvidence["source"] {
  return { label: r.source === "live" ? "hyperliquid" : "snapshot", url: `/markets/${asset}` };
}

/** Lowercased word tokens (≥ 2 chars) of an event query. */
function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/** Pure: one check against pre-loaded data → status and the number behind it. */
export function evaluateCheck(check: ThesisCheck, data: CheckData): CheckResult {
  const now = Date.parse(data.now);
  const fromReading = (asset: string, value: number | null, ok: (v: number) => boolean): CheckResult => {
    const r = data.current[asset];
    if (!r || value === null) return { status: "unknown" };
    const evidence: ThesisEvidence = { value: round(value, 8), source: readingSource(asset, r), ts: r.ts };
    if (now - Date.parse(r.ts) > MAX_READING_AGE_MS) return { status: "unknown", evidence };
    return { status: ok(value) ? "supported" : "contradicted", evidence };
  };

  switch (check.kind) {
    case "metric_threshold": {
      const o = data.observations[check.series];
      if (!o) return { status: "unknown" };
      return {
        status: cmp(o.value, check.op, check.value) ? "supported" : "contradicted",
        evidence: { value: o.value, source: { label: `series ${check.series}` }, ts: o.ts },
      };
    }
    case "price_vs_level": {
      const r = data.current[check.asset];
      return fromReading(check.asset, r?.price ?? null, (v) => cmp(v, check.op, check.level));
    }
    case "funding_sign": {
      const r = data.current[check.asset];
      return fromReading(check.asset, r?.funding ?? null, (v) => (check.sign === "positive" ? v > 0 : v < 0));
    }
    case "oi_change": {
      const r = data.current[check.asset];
      const p = data.prior[priorKey(check.asset, check.window_h)];
      // The baseline must sit in [now − 2·window, now − window], or the change is over the wrong span.
      if (!r || r.oiUsd === null || !p || p.oiUsd === null || p.oiUsd <= 0) return { status: "unknown" };
      if (Date.parse(p.ts) < now - 2 * check.window_h * H) return { status: "unknown" };
      const pct = (r.oiUsd / p.oiUsd - 1) * 100;
      return fromReading(check.asset, round(pct, 2), (v) => cmp(v, check.op, check.pct));
    }
    case "event_exists": {
      const words = tokens(check.query);
      if (!words.length) return { status: "unknown" };
      const since = now - check.since_h * H;
      const hit = data.events.find((e) => {
        if (Date.parse(e.firstSeen) < since) return false;
        const hay = [e.title, e.summary ?? "", ...e.entities, ...e.assets].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      // No match in our ingest is not proof the event did not happen: unknown, not contradicted.
      if (!hit) return { status: "unknown", evidence: { value: "no matching event", source: { label: "intel events" }, ts: data.now } };
      const src = hit.sources[0];
      return {
        status: "supported",
        evidence: { value: hit.title.slice(0, 300), source: src ? { label: src.label, ...(src.url ? { url: src.url } : {}) } : { label: hit.origin }, ts: hit.firstSeen },
      };
    }
    case "unknown":
      return { status: "unknown" };
  }
}

/** Invalidation checks are phrased "true when invalidated". */
const invalidationStatus = (s: CheckStatus): "triggered" | "clear" | "unknown" => (s === "supported" ? "triggered" : s === "contradicted" ? "clear" : "unknown");

/** Loads what the checks need. Every source is best effort: a failure leaves its checks unknown. */
export async function loadCheckData(deps: ThesisDeps, checks: ThesisCheck[]): Promise<CheckData> {
  const now = deps.now();
  const data: CheckData = { now: now.toISOString(), observations: {}, current: {}, prior: {}, events: [] };
  const warn = (what: string, e: unknown) => console.warn(`[intel] thesis ${what}: ${e instanceof Error ? e.message : String(e)}`);

  const series = [...new Set(checks.flatMap((c) => (c.kind === "metric_threshold" ? [c.series] : [])))];
  const assets = [...new Set(checks.flatMap((c) => (c.kind === "price_vs_level" || c.kind === "funding_sign" || c.kind === "oi_change" ? [c.asset] : [])))];
  const windows = checks.flatMap((c) => (c.kind === "oi_change" ? [{ asset: c.asset, h: c.window_h }] : []));
  const sinceH = Math.max(0, ...checks.map((c) => (c.kind === "event_exists" ? c.since_h : 0)));

  if (series.length && deps.observations) {
    try {
      for (const o of await deps.observations(series)) if (Number.isFinite(o.value)) data.observations[o.seriesId] = { value: o.value, ts: iso(o.ts) };
    } catch (e) {
      warn("observations", e);
    }
  }

  if (assets.length && deps.ctxs) {
    try {
      const want = new Set(assets);
      for (const c of await deps.ctxs()) {
        if (!want.has(c.name) || !(c.markPx > 0)) continue;
        data.current[c.name] = { price: c.markPx, funding: Number.isFinite(c.funding) ? c.funding : null, oiUsd: c.openInterest * c.markPx, ts: data.now, source: "live" };
      }
    } catch (e) {
      warn("live contexts", e);
    }
  }

  await Promise.all([
    ...assets
      .filter((a) => !data.current[a])
      .map(async (a) => {
        try {
          const s = await deps.store.nearestSnapshot(a, now, "before");
          if (s) data.current[a] = { price: s.price, funding: s.funding, oiUsd: s.oiUsd, ts: s.ts, source: "snapshot" };
        } catch (e) {
          warn(`snapshot ${a}`, e);
        }
      }),
    ...windows.map(async ({ asset, h }) => {
      try {
        const s = await deps.store.nearestSnapshot(asset, new Date(now.getTime() - h * H), "before");
        if (s) data.prior[priorKey(asset, h)] = s;
      } catch (e) {
        warn(`baseline snapshot ${asset}`, e);
      }
    }),
    (async () => {
      if (!sinceH) return;
      try {
        data.events = await deps.store.listEvents({ since: new Date(now.getTime() - sinceH * H), limit: EVENTS_LIMIT });
      } catch (e) {
        warn("events", e);
      }
    })(),
  ]);
  return data;
}

type ThesisBody = Pick<Thesis, "claims" | "invalidation">;

/** Re-evaluates every claim and invalidation check; text and kinds are kept. */
export async function evaluateThesis(deps: ThesisDeps, t: ThesisBody): Promise<ThesisBody> {
  const checks = [...t.claims.map((c) => c.check), ...t.invalidation.flatMap((i) => (i.check ? [i.check] : []))];
  const data = await loadCheckData(deps, checks);
  const claims = t.claims.map(({ evidence: _e, ...c }) => {
    const r = evaluateCheck(c.check, data);
    return { ...c, status: r.status, ...(r.evidence ? { evidence: r.evidence } : {}) };
  });
  const invalidation = t.invalidation.map(({ status: _s, evidence: _e, ...i }) => {
    if (!i.check) return i;
    const r = evaluateCheck(i.check, data);
    return { ...i, status: invalidationStatus(r.status), ...(r.evidence ? { evidence: r.evidence } : {}) };
  });
  return { claims, invalidation };
}

// ---------------------------------------------------------------- extraction

const ExtractedClaimSchema = z.object({ kind: z.enum(["claim", "assumption"]), text: z.string().trim().min(1).max(600), check: ThesisCheckSchema }).strict();
/** What the model returns. wrongIf stays raw so validateLines can drop bad lines instead of failing the call (I0.7). */
export const ThesisExtractionSchema = z
  .object({
    assets: z.array(AssetSchema).max(20),
    claims: z.array(ExtractedClaimSchema).min(1).max(20),
    invalidation: z.array(z.object({ text: z.string().trim().min(1).max(300), check: ThesisCheckSchema.optional() }).strict()).max(10),
    wrongIf: z.array(z.unknown()).max(10),
  })
  .strict();
export type ThesisExtraction = z.infer<typeof ThesisExtractionSchema>;

const cmpOp = { type: "string", enum: [">", ">=", "<", "<="] };
const assetJson = { type: "string", maxLength: 24, pattern: "^([A-Za-z0-9]+:)?[A-Za-z0-9]+$" };
const hoursJson = { type: "integer", minimum: 1, maximum: 2160 };
const obj = (kind: string, properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { kind: { type: "string", enum: [kind] }, ...properties },
  required: ["kind", ...required],
  additionalProperties: false,
});
/** JSON schema mirror of ThesisCheckSchema. */
export const thesisCheckJsonSchema = {
  anyOf: [
    obj("metric_threshold", { series: { type: "string", maxLength: 80, pattern: "^[A-Za-z0-9_.:-]+$" }, op: cmpOp, value: { type: "number" } }, ["series", "op", "value"]),
    obj("price_vs_level", { asset: assetJson, op: cmpOp, level: { type: "number", exclusiveMinimum: 0 } }, ["asset", "op", "level"]),
    obj("funding_sign", { asset: assetJson, sign: { type: "string", enum: ["positive", "negative"] } }, ["asset", "sign"]),
    obj("oi_change", { asset: assetJson, window_h: hoursJson, op: cmpOp, pct: { type: "number", description: "percent, 5 = +5%" } }, ["asset", "window_h", "op", "pct"]),
    obj("event_exists", { query: { type: "string", minLength: 1, maxLength: 200 }, since_h: hoursJson }, ["query", "since_h"]),
    obj("unknown", { reason: { type: "string", minLength: 1, maxLength: 300 } }, []),
  ],
};

const extractionJsonSchema = {
  type: "object" as const,
  properties: {
    assets: { type: "array", maxItems: 20, items: assetJson },
    claims: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: { kind: { type: "string", enum: ["claim", "assumption"] }, text: { type: "string", minLength: 1, maxLength: 600 }, check: thesisCheckJsonSchema },
        required: ["kind", "text", "check"],
        additionalProperties: false,
      },
    },
    invalidation: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        properties: { text: { type: "string", minLength: 1, maxLength: 300 }, check: thesisCheckJsonSchema },
        required: ["text"],
        additionalProperties: false,
      },
    },
    wrongIf: { ...claimsJsonSchema, maxItems: 10 },
  },
  required: ["assets", "claims", "invalidation", "wrongIf"],
  additionalProperties: false,
};

export const THESIS_SYSTEM = `You extract the testable structure of a trading thesis written by the operator. You do not judge it, predict direction, set price targets or give advice. Code evaluates everything you return against stored market data.

Return:
- assets: the Hyperliquid perp coin names the thesis is about (BTC, ETH, SOL, HYPE, kPEPE …).
- claims: every claim the thesis states (kind "claim") and every unstated premise it relies on (kind "assumption"), each restated in one sentence close to the operator's words, each with exactly one check from this catalog:
  · metric_threshold {series, op, value}: a stored series against a number. Series ids: fng.value (Fear & Greed 0–100), cg.btc_dominance (percent), cg.total_mcap_usd, llama.stablecoin_cap_usd, deribit.btc_dvol, fred.DGS10 and fred.DGS2 (percent), fred.spread_2s10s, fred.VIXCLS, fred.DTWEXBGS, fred.DCOILWTICO, fred.net_liquidity, hl.total_oi_usd, hl.funding_skew, hl.oi.<COIN> (USD), hl.funding.<COIN> (hourly rate).
  · price_vs_level {asset, op, level}: the current mark against a price.
  · funding_sign {asset, sign: "positive" | "negative"}: the current funding rate's sign.
  · oi_change {asset, window_h, op, pct}: percent change of open interest over the last window_h hours (pct 5 = +5%).
  · event_exists {query, since_h}: a news, governance or calendar event matching the query's keywords in the last since_h hours. Use few, specific keywords.
  · unknown {reason}: nothing above can check it. Prefer this to a forced mapping.
  op is one of > >= < <=. Do not invent thresholds the thesis does not imply.
- invalidation: the levels or conditions that would invalidate the thesis, each as text plus, when the catalog can express it, a check that is TRUE when the thesis is invalidated.
- wrongIf: what has to be true for this thesis to be wrong, 1–5 lines. Each line is {"tag":"hypothesis","text"}; use {"tag":"observed","text","source":{"label","url"?},"ts"} only for a fact the thesis itself quotes with a source and time.`;

export type ExtractResult = { ok: true; extraction: ThesisExtraction & { wrongIf: Thesis["wrongIf"] }; trace: Thesis["trace"] } | { ok: false; error: string; trace: LlmTrace };

/** Strong-tier extraction of claims, checks, invalidation and wrongIf from free text. Never throws. */
export async function extractThesis(deps: ThesisDeps, text: string): Promise<ExtractResult> {
  const res = await completeStructured({
    tier: "strong",
    system: THESIS_SYSTEM,
    user: `Thesis:\n${text}`,
    schema: ThesisExtractionSchema,
    jsonSchema: extractionJsonSchema,
    promptVersion: THESIS_PROMPT_VERSION,
    cacheKey: `thesis:${createHash("sha256").update(text).digest("hex")}`,
    signal: deps.signal,
    deps: deps.llm,
  });
  if (!res.ok) return res;
  const { claims: wrongIf, ...counts } = validateLines(res.value.wrongIf, text);
  // claims and invalidation text are LLM lines too: same number/advice check against the thesis input.
  const nums = payloadNumbers(text);
  const ok = (l: { text: string }) => lineVerdict(l.text, nums) === null;
  const claims = res.value.claims.filter(ok);
  const invalidation = res.value.invalidation.filter(ok);
  const dropped = counts.dropped + (res.value.claims.length - claims.length) + (res.value.invalidation.length - invalidation.length);
  return { ok: true, extraction: { ...res.value, claims, invalidation, wrongIf }, trace: { ...res.trace, ...counts, dropped, cached: res.cached } };
}

function assetsOf(extracted: string[], checks: ThesisCheck[]): string[] {
  const fromChecks = checks.flatMap((c) => ("asset" in c ? [c.asset] : []));
  return [...new Set([...extracted, ...fromChecks])];
}

/** POST /theses: extract, evaluate, store. */
export async function createThesis(deps: ThesisDeps, text: string): Promise<{ ok: true; thesis: Thesis } | { ok: false; error: string }> {
  const ex = await extractThesis(deps, text);
  if (!ex.ok) return { ok: false, error: ex.error };
  const { assets, claims, invalidation, wrongIf } = ex.extraction;
  const body = await evaluateThesis(deps, {
    claims: claims.map((c) => ({ ...c, status: "unknown" as const })),
    invalidation: invalidation.map((i) => ({ text: i.text, ...(i.check ? { check: i.check } : {}) })),
  });
  const checks = [...claims.map((c) => c.check), ...invalidation.flatMap((i) => (i.check ? [i.check] : []))];
  const thesis = await deps.store.insertThesis({
    text,
    assets: assetsOf(assets, checks),
    ...body,
    wrongIf,
    checkedAt: deps.now().toISOString(),
    trace: ex.trace,
    history: [historyEntry(deps.now().toISOString(), body)],
  });
  return { ok: true, thesis };
}

/** history entry for one evaluation: claims then invalidation, in order. */
function historyEntry(ts: string, b: ThesisBody): ThesisHistoryEntry {
  return {
    ts,
    checks: [
      ...b.claims.map((c) => ({ status: c.status, value: c.evidence?.value ?? null })),
      ...b.invalidation.map((i) => ({ status: i.status ?? ("unknown" as const), value: i.evidence?.value ?? null })),
    ],
  };
}

const opWord = { ">": "above", ">=": "at or above", "<": "below", "<=": "at or below" };
function checkWords(c: ThesisCheck): string {
  switch (c.kind) {
    case "metric_threshold": return `${c.series} ${opWord[c.op]} ${c.value}`;
    case "price_vs_level": return `${c.asset} price ${opWord[c.op]} ${c.level}`;
    case "funding_sign": return `${c.asset} funding ${c.sign}`;
    case "oi_change": return `${c.asset} open interest change over ${c.window_h}h ${opWord[c.op]} ${c.pct}%`;
    case "event_exists": return `event "${c.query}" in the last ${c.since_h}h`;
    case "unknown": return "unchecked";
  }
}

/** Facts only; a premise text that trips the advice guard is replaced by a neutral label. */
function brokenAlert(t: Thesis, text: string, check: ThesisCheck, ev?: ThesisEvidence) {
  const premise = isAdvice(text) ? `a premise of the ${t.assets.join("/") || "saved"} thesis` : text;
  const now = ev ? `now ${ev.value ?? "n/a"} (${ev.source.label}, ${ev.ts})` : "now n/a";
  return { title: `Premise no longer holds: ${premise}`, line: `${checkWords(check)}: ${now}` };
}

/**
 * Re-evaluates a stored thesis from its saved checks; no LLM call. Appends a history entry
 * and sends one alert per transition supported → contradicted / clear → triggered
 * (never repeats while the state is unchanged). Null when it does not exist.
 */
export async function checkThesis(deps: ThesisDeps, id: string): Promise<Thesis | null> {
  const t = await deps.store.getThesis(id);
  if (!t) return null;
  const body = await evaluateThesis(deps, t);
  const checkedAt = deps.now().toISOString();
  const history = [...(t.history ?? []), historyEntry(checkedAt, body)].slice(-HISTORY_CAP);
  // Compare-and-set on the history we read: a concurrent check that won the race owns the write and the alert.
  const out = await deps.store.updateThesis(id, { ...body, checkedAt, history }, t.history ?? []);
  if (!out) return deps.store.getThesis(id);
  // ponytail: state is saved before the send, so if every channel fails the alert is lost (no retry); add an outbox if it matters.
  if (deps.notifier) {
    const hits = [
      ...body.claims.flatMap((c, i) => (t.claims[i]?.status === "supported" && c.status === "contradicted" ? [brokenAlert(t, c.text, c.check, c.evidence)] : [])),
      ...body.invalidation.flatMap((v, i) => (v.check && t.invalidation[i]?.status === "clear" && v.status === "triggered" ? [brokenAlert(t, v.text, v.check, v.evidence)] : [])),
    ];
    for (const h of hits) await sendIntel(deps.notifier, { title: h.title, lines: [h.line] });
  }
  return out;
}

/** Brief hook: rechecks every thesis each run. Returns the rechecked theses. */
export async function recheckAll(deps: ThesisDeps): Promise<Thesis[]> {
  const out: Thesis[] = [];
  for (const t of await deps.store.listTheses()) {
    try {
      const r = await checkThesis(deps, t.id);
      if (r) out.push(r);
    } catch (e) {
      console.warn(`[intel] thesis ${t.id} recheck: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
