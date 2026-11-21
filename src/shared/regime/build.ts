// The model's JSON as the next RegimeThesis: every field checked and clamped, weights filled from the catalog,
// consensus computed by code, URLs kept only when they were really seen (a search result or a collected piece of
// evidence), version counted on from the previous document.
import { consensus } from "./consensus.js";
import { isKind, sourceFor, weightFor } from "./sources.js";
import type {
  Catalyst,
  Conviction,
  HistoryEntry,
  KeyLevel,
  Lean,
  Link,
  Narrative,
  RegimeThesis,
  Scenario,
  SourceRead,
  Stance,
  ThesisChange,
  ThesisLine,
} from "./types.js";

type O = Record<string, unknown>;
const asObj = (x: unknown): O => (x && typeof x === "object" && !Array.isArray(x) ? (x as O) : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const s = (x: unknown, max = 2000): string => (typeof x === "string" ? x.trim().slice(0, max) : "");
const sOrNull = (x: unknown, max = 200): string | null => s(x, max) || null;
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const strs = (x: unknown, max = 12, len = 200): string[] => arr(x).map((v) => s(v, len)).filter(Boolean).slice(0, max);
const oneOf = <T extends string>(x: unknown, allowed: readonly T[], dflt: T): T => (allowed.includes(x as T) ? (x as T) : dflt);

export const STANCES = ["risk_off", "defensive", "neutral", "constructive", "risk_on"] as const satisfies readonly Stance[];
export const CONVICTIONS = ["low", "medium", "high"] as const satisfies readonly Conviction[];

/** Canonical URL for comparing: lower-case host, no fragment, no trailing slash, no tracking parameters. */
export function urlKey(u: string): string {
  try {
    const x = new URL(u.trim());
    x.hash = "";
    x.hostname = x.hostname.toLowerCase();
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|ref$|mc_)/i.test(k)) x.searchParams.delete(k);
    return x.toString().replace(/\/+(\?|$)/, "$1");
  } catch {
    return u.trim();
  }
}

export const clampLean = (x: unknown): Lean => {
  const n = typeof x === "number" && Number.isFinite(x) ? Math.round(x) : 0;
  return Math.max(-2, Math.min(2, n)) as Lean;
};

export type BuildDeps = {
  now: string;
  model: string;
  id: string;
  previous: RegimeThesis | null;
  /** Every URL the run saw: search results and collected evidence. Anything else the model cites is dropped. */
  seen: Link[];
  evidenceIds: string[];
  usage: RegimeThesis["usage"];
};

export function buildThesis(raw: unknown, deps: BuildDeps): RegimeThesis {
  const o = asObj(raw);
  const allowed = new Map(deps.seen.map((l) => [urlKey(l.url), l]));
  const okUrl = (u: unknown): string | null => {
    const v = s(u, 1000);
    return v && allowed.has(urlKey(v)) ? allowed.get(urlKey(v))!.url : null;
  };

  const phase = s(o.phase, 200) || deps.previous?.phase || "No read yet";

  // One read per source: duplicates merge into the first, keeping the firmer confidence.
  const reads = new Map<string, SourceRead>();
  for (const r0 of arr(o.source_reads)) {
    const r = asObj(r0);
    const url = okUrl(r.url);
    const kind = isKind(r.kind) ? r.kind : "news";
    let source = s(r.source, 80).toLowerCase();
    const def = sourceFor(source, url);
    if (def) source = def.id;
    if (!source) continue;
    const read: SourceRead = {
      source,
      name: s(r.name, 120) || def?.name || source,
      kind: def?.kind ?? kind,
      lean: clampLean(r.lean),
      confidence: Math.max(0, Math.min(1, num(r.confidence) ?? 0.5)),
      claim: s(r.claim, 600),
      url,
      as_of: sOrNull(r.as_of, 40),
      weight: weightFor(source, def?.kind ?? kind, url),
    };
    if (!read.claim) continue;
    const prev = reads.get(source);
    if (!prev) reads.set(source, read);
    else if (read.confidence > prev.confidence) reads.set(source, read);
  }
  const source_reads = [...reads.values()].slice(0, 40);

  const key_levels: KeyLevel[] = arr(o.key_levels)
    .map(asObj)
    .map((k) => ({ metric: s(k.metric, 120), level: s(k.level, 80), price: num(k.price), meaning: s(k.meaning, 400), status: s(k.status, 80) || "untested", sources: strs(k.sources, 6, 80), as_of: sOrNull(k.as_of, 40) }))
    .filter((k) => k.metric && k.level)
    .slice(0, 24);

  const lines: ThesisLine[] = arr(o.lines)
    .map(asObj)
    .map((l) => ({ kind: oneOf(l.kind, ["bull_confirm", "bear_trigger", "invalidation"] as const, "bear_trigger"), text: s(l.text, 400), price: num(l.price) }))
    .filter((l) => l.text)
    .slice(0, 12);

  let scenarios: Scenario[] = arr(o.scenarios)
    .map(asObj)
    .map((x) => ({ name: s(x.name, 120), probability: Math.max(0, num(x.probability) ?? 0), path: s(x.path, 600), trigger: s(x.trigger, 300) }))
    .filter((x) => x.name)
    .slice(0, 6);
  // Probabilities as percentages (40 rather than 0.4), or not summing to 1: normalise.
  const total = scenarios.reduce((a, x) => a + x.probability, 0);
  if (total > 0 && Math.abs(total - 1) > 0.02) scenarios = scenarios.map((x) => ({ ...x, probability: Math.round((x.probability / total) * 100) / 100 }));

  const catalysts: Catalyst[] = arr(o.catalysts)
    .map(asObj)
    .map((c) => ({ date: sOrNull(c.date, 40), event: s(c.event, 200), why: s(c.why, 400), status: oneOf(c.status, ["upcoming", "resolved"] as const, "upcoming") }))
    .filter((c) => c.event)
    .slice(0, 16);

  const narratives: Narrative[] = arr(o.narratives)
    .map(asObj)
    .map((n) => ({ name: s(n.name, 120), read: s(n.read, 500) }))
    .filter((n) => n.name)
    .slice(0, 10);

  const changes: ThesisChange[] = arr(o.changes)
    .map(asObj)
    .map((c) => ({ what: s(c.what, 160), from: sOrNull(c.from, 300), to: s(c.to, 300), because: s(c.because, 500), sources: strs(c.sources, 8, 80) }))
    .filter((c) => c.what && c.to)
    .slice(0, 12);

  // Sources list: what the model cited, then every read's URL, all limited to URLs the run saw.
  const links: Link[] = [];
  const have = new Set<string>();
  const add = (u: string | null) => {
    if (!u) return;
    const k = urlKey(u);
    if (have.has(k)) return;
    have.add(k);
    links.push(allowed.get(k)!);
  };
  for (const u of arr(o.source_urls)) add(okUrl(u));
  for (const r of source_reads) add(r.url);

  return {
    id: deps.id,
    version: (deps.previous?.version ?? 0) + 1,
    created: deps.now,
    model: deps.model,
    phase,
    stance: oneOf(o.stance, STANCES, deps.previous?.stance ?? "neutral"),
    conviction: oneOf(o.conviction, CONVICTIONS, "low"),
    tldr: s(o.tldr, 1500),
    macro: s(o.macro, 1500),
    alts: s(o.alts, 1000),
    key_levels,
    lines,
    scenarios,
    source_reads,
    consensus: consensus(source_reads),
    agreement_notes: s(o.agreement_notes, 1500),
    catalysts,
    narratives,
    changes,
    changelog: s(o.changelog, 1500) || "No changelog given.",
    sources: links.slice(0, 40),
    evidence: deps.evidenceIds.slice(0, 200),
    usage: deps.usage,
  };
}

export const historyEntry = (t: RegimeThesis): HistoryEntry => ({
  id: t.id,
  version: t.version,
  created: t.created,
  phase: t.phase,
  stance: t.stance,
  conviction: t.conviction,
  consensus: t.source_reads.length ? t.consensus.score : null,
  changelog: t.changelog,
});

/** A seed document (his notes, already shaped) checked through the same path, with its own reads and links trusted. */
export function buildSeed(raw: unknown, deps: Omit<BuildDeps, "seen" | "evidenceIds" | "usage" | "previous" | "model">): RegimeThesis {
  const o = asObj(raw);
  const urls: Link[] = [];
  for (const r of arr(o.source_reads)) {
    const u = s(asObj(r).url, 1000);
    if (/^https?:\/\//i.test(u)) urls.push({ title: s(asObj(r).name, 120) || u, url: u });
  }
  for (const l of arr(o.sources)) {
    const x = asObj(l);
    const u = s(x.url, 1000);
    if (/^https?:\/\//i.test(u)) urls.push({ title: s(x.title, 300) || u, url: u });
  }
  for (const u of arr(o.source_urls)) if (typeof u === "string" && /^https?:\/\//i.test(u)) urls.push({ title: u, url: u });
  const sourceUrls = [...arr(o.source_urls), ...arr(o.sources).map((l) => asObj(l).url)];
  return buildThesis({ ...o, source_urls: sourceUrls }, { ...deps, model: "seed", previous: null, seen: urls, evidenceIds: [], usage: { input_tokens: 0, output_tokens: 0, web_searches: 0 } });
}
