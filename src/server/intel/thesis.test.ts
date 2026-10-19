import { describe, expect, test } from "bun:test";
import type { IntelEvent, SnapshotRow, ThesisCheck } from "../../shared/intel.js";
import type { AssetCtx } from "../../shared/types.js";
import { ScriptedProvider } from "../desk/testkit.js";
import type { LLMProvider } from "../llm/provider.js";
import { checkThesis, createThesis, HISTORY_CAP, evaluateCheck, extractThesis, loadCheckData, recheckAll, type CheckData, type ThesisDeps } from "./thesis.js";
import type { Notifier } from "../desk/notify.js";
import { MemoryIntelStore } from "./store.js";

const NOW = "2026-10-13T12:00:00.000Z";
const at = (hoursAgo: number) => new Date(Date.parse(NOW) - hoursAgo * 3600_000).toISOString();

const snap = (asset: string, hoursAgo: number, p: Partial<SnapshotRow> = {}): SnapshotRow => ({
  asset,
  ts: at(hoursAgo),
  price: 100,
  vol24h: null,
  funding: 0.0001,
  oiUsd: 1_000_000,
  premium: null,
  basis: null,
  depthBid1: null,
  depthAsk1: null,
  depthBid2: null,
  depthAsk2: null,
  spreadBps: null,
  ...p,
});

const event = (p: Partial<IntelEvent>): IntelEvent => ({
  id: "e1",
  key: "k1",
  clusterId: null,
  type: "unlock",
  title: "HYPE token unlock scheduled",
  summary: "Team tokens vest on Nov 29",
  entities: ["Hyperliquid"],
  assets: ["HYPE"],
  magnitude: "med",
  sources: [{ label: "Hyperliquid blog", url: "https://example.com/unlock" }],
  origin: "rss",
  firstSeen: at(5),
  scheduledAt: null,
  catalyst: null,
  tag: "observed",
  ...p,
});

function data(p: Partial<CheckData> = {}): CheckData {
  return {
    now: NOW,
    observations: { "fng.value": { value: 72, ts: at(2) } },
    current: {
      HYPE: { price: 40, funding: 0.00012, oiUsd: 1_200_000, ts: at(0.2), source: "snapshot" },
      BTC: { price: 80_000, funding: -0.00002, oiUsd: 9e9, ts: at(30), source: "snapshot" },
    },
    prior: { "HYPE|24": snap("HYPE", 24.1, { oiUsd: 1_000_000 }), "HYPE|168": snap("HYPE", 400, { oiUsd: 1_000_000 }) },
    events: [event({})],
    ...p,
  };
}

const ev = (check: ThesisCheck, d = data()) => evaluateCheck(check, d);

describe("evaluateCheck", () => {
  test("metric_threshold reads the latest observation", () => {
    expect(ev({ kind: "metric_threshold", series: "fng.value", op: ">", value: 60 })).toEqual({
      status: "supported",
      evidence: { value: 72, source: { label: "series fng.value" }, ts: at(2) },
    });
    expect(ev({ kind: "metric_threshold", series: "fng.value", op: "<=", value: 50 }).status).toBe("contradicted");
    expect(ev({ kind: "metric_threshold", series: "fred.DGS10", op: ">", value: 4 })).toEqual({ status: "unknown" });
  });

  test("price_vs_level: supported, contradicted, missing, stale", () => {
    expect(ev({ kind: "price_vs_level", asset: "HYPE", op: ">", level: 35 })).toEqual({
      status: "supported",
      evidence: { value: 40, source: { label: "snapshot", url: "/markets/HYPE" }, ts: at(0.2) },
    });
    expect(ev({ kind: "price_vs_level", asset: "HYPE", op: "<", level: 35 }).status).toBe("contradicted");
    expect(ev({ kind: "price_vs_level", asset: "SOL", op: "<", level: 35 })).toEqual({ status: "unknown" });
    // BTC's reading is 30 h old: shown as evidence, does not decide.
    const stale = ev({ kind: "price_vs_level", asset: "BTC", op: ">", level: 1 });
    expect(stale.status).toBe("unknown");
    expect(stale.evidence).toMatchObject({ value: 80_000, ts: at(30) });
  });

  test("funding_sign", () => {
    expect(ev({ kind: "funding_sign", asset: "HYPE", sign: "positive" }).status).toBe("supported");
    expect(ev({ kind: "funding_sign", asset: "HYPE", sign: "negative" }).status).toBe("contradicted");
    const d = data({ current: { HYPE: { price: 40, funding: null, oiUsd: null, ts: at(0), source: "live" } } });
    expect(ev({ kind: "funding_sign", asset: "HYPE", sign: "positive" }, d)).toEqual({ status: "unknown" });
  });

  test("oi_change: percent vs the baseline, which must lie within 2× the window", () => {
    const up = ev({ kind: "oi_change", asset: "HYPE", window_h: 24, op: ">", pct: 5 });
    expect(up).toEqual({ status: "supported", evidence: { value: 20, source: { label: "snapshot", url: "/markets/HYPE" }, ts: at(0.2) } });
    expect(ev({ kind: "oi_change", asset: "HYPE", window_h: 24, op: "<", pct: 0 }).status).toBe("contradicted");
    // 168 h baseline sits 400 h back (> 2 × 168): wrong span.
    expect(ev({ kind: "oi_change", asset: "HYPE", window_h: 168, op: ">", pct: 5 })).toEqual({ status: "unknown" });
    expect(ev({ kind: "oi_change", asset: "ETH", window_h: 24, op: ">", pct: 5 })).toEqual({ status: "unknown" });
  });

  test("event_exists: keyword match inside the window; no match is unknown, not contradicted", () => {
    expect(ev({ kind: "event_exists", query: "hype unlock", since_h: 48 })).toEqual({
      status: "supported",
      evidence: { value: "HYPE token unlock scheduled", source: { label: "Hyperliquid blog", url: "https://example.com/unlock" }, ts: at(5) },
    });
    expect(ev({ kind: "event_exists", query: "hype unlock", since_h: 2 }).status).toBe("unknown");
    const miss = ev({ kind: "event_exists", query: "solana outage", since_h: 48 });
    expect(miss.status).toBe("unknown");
    expect(miss.evidence?.value).toBe("no matching event");
  });

  test("unknown stays unknown", () => {
    expect(ev({ kind: "unknown", reason: "narrative" })).toEqual({ status: "unknown" });
  });
});

// ---------------------------------------------------------------- with a store

const extraction = {
  assets: ["HYPE"],
  claims: [
    { kind: "claim", text: "HYPE open interest keeps rising", check: { kind: "oi_change", asset: "HYPE", window_h: 24, op: ">", pct: 5 } },
    { kind: "claim", text: "Funding stays positive", check: { kind: "funding_sign", asset: "HYPE", sign: "positive" } },
    { kind: "assumption", text: "Sentiment is greedy", check: { kind: "metric_threshold", series: "fng.value", op: ">", value: 60 } },
    { kind: "assumption", text: "Unlock recipients hold", check: { kind: "unknown", reason: "no on-chain data" } },
  ],
  invalidation: [
    { text: "HYPE below $35", check: { kind: "price_vs_level", asset: "HYPE", op: "<", level: 35 } },
    { text: "BTC daily close under $79.2K", check: { kind: "price_vs_level", asset: "BTC", op: "<", level: 79_200 } },
    { text: "The unlock is delayed" },
  ],
  wrongIf: [{ tag: "hypothesis", text: "Unlock recipients sell into strength." }, { tag: "observed", text: "no source given" }],
};

function setup(emit: unknown = extraction, opts: { provider?: LLMProvider | null; ctxs?: AssetCtx[] } = {}) {
  const store = new MemoryIntelStore(() => new Date(NOW));
  const provider = opts.provider === undefined ? new ScriptedProvider("strong-model", () => [{ calls: [{ name: "emit", input: emit }] }]) : opts.provider;
  let makes = 0;
  const deps: ThesisDeps = {
    store,
    llm: { makeProvider: () => (makes++, provider), cache: store, now: () => new Date(NOW), dailyCap: 200 },
    now: () => new Date(NOW),
    observations: async (ids) => ids.filter((id) => id === "fng.value").map((seriesId) => ({ seriesId, ts: new Date(at(2)), value: 72 })),
    ...(opts.ctxs ? { ctxs: async () => opts.ctxs! } : {}),
  };
  return { store, deps, makes: () => makes };
}

async function seed(store: MemoryIntelStore) {
  await store.insertSnapshots([snap("HYPE", 24.5, { oiUsd: 1_000_000 }), snap("HYPE", 0.25, { price: 40, oiUsd: 1_150_000, funding: 0.0001 }), snap("BTC", 0.25, { price: 81_000 })]);
}

describe("loadCheckData", () => {
  test("live contexts win over snapshots; baselines and events load per check", async () => {
    const ctx = { name: "HYPE", markPx: 41, openInterest: 30_000, funding: -0.00001 } as AssetCtx;
    const { store, deps } = setup(extraction, { ctxs: [ctx] });
    await seed(store);
    await store.upsertEvents([{ ...event({}), firstSeen: at(3) }]);
    const d = await loadCheckData(deps, [
      { kind: "funding_sign", asset: "HYPE", sign: "positive" },
      { kind: "price_vs_level", asset: "BTC", op: ">", level: 1 },
      { kind: "oi_change", asset: "HYPE", window_h: 24, op: ">", pct: 1 },
      { kind: "event_exists", query: "unlock", since_h: 24 },
      { kind: "metric_threshold", series: "fng.value", op: ">", value: 1 },
    ]);
    expect(d.current.HYPE).toEqual({ price: 41, funding: -0.00001, oiUsd: 1_230_000, ts: NOW, source: "live" });
    expect(d.current.BTC).toMatchObject({ price: 81_000, source: "snapshot" });
    expect(d.prior["HYPE|24"]?.ts).toBe(at(24.5));
    expect(d.events.map((e) => e.title)).toEqual(["HYPE token unlock scheduled"]);
    expect(d.observations["fng.value"]).toEqual({ value: 72, ts: at(2) });
  });

  test("a failing source leaves its checks unknown instead of throwing", async () => {
    const { deps } = setup();
    deps.observations = async () => {
      throw new Error("db down");
    };
    const d = await loadCheckData(deps, [{ kind: "metric_threshold", series: "fng.value", op: ">", value: 1 }]);
    expect(d.observations).toEqual({});
  });
});

describe("extractThesis", () => {
  test("strong tier, claim-tagged wrongIf with bad lines dropped and counted", async () => {
    const { deps } = setup();
    const r = await extractThesis(deps, "HYPE grinds higher into the unlock because perp OI keeps rising while funding stays flat; out below $35 or BTC under $79.2K");
    if (!r.ok) throw new Error(r.error);
    expect(r.extraction.claims).toHaveLength(4);
    expect(r.extraction.wrongIf).toEqual([{ tag: "hypothesis", text: "Unlock recipients sell into strength." }]);
    expect(r.trace).toMatchObject({ tier: "strong", model: "strong-model", dropped: 1, promptVersion: "thesis.v1" });
  });

  test("claims and invalidation lines with unsupported numbers or advice are dropped", async () => {
    const bad = {
      ...extraction,
      claims: [...extraction.claims, { kind: "claim", text: "HYPE reaches 47 by Friday", check: { kind: "unknown", reason: "x" } }, { kind: "claim", text: "Sell HYPE here", check: { kind: "unknown", reason: "x" } }],
      invalidation: [...extraction.invalidation, { text: "HYPE below $12" }],
    };
    const { deps } = setup(bad);
    const r = await extractThesis(deps, "HYPE grinds higher into the unlock because perp OI keeps rising; out below $35 or BTC under $79.2K");
    if (!r.ok) throw new Error(r.error);
    expect(r.extraction.claims).toHaveLength(4);
    expect(r.extraction.invalidation).toHaveLength(3);
    expect(r.trace).toMatchObject({ dropped: 4 });
  });

  test("a check outside the catalog fails closed after one retry", async () => {
    const bad = { ...extraction, claims: [{ kind: "claim", text: "x", check: { kind: "vibes", asset: "HYPE" } }] };
    const { deps } = setup(bad);
    const r = await extractThesis(deps, "anything");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toStartWith("invalid output after retry");
      expect(r.trace.attempts).toBe(2);
    }
  });

  test("no provider → llm not configured", async () => {
    const { deps } = setup(extraction, { provider: null });
    expect(await extractThesis(deps, "x")).toMatchObject({ ok: false, error: "llm not configured" });
  });
});

describe("createThesis / checkThesis / recheckForAssets", () => {
  test("stores claims with code-evaluated statuses and invalidation states", async () => {
    const { store, deps } = setup();
    await seed(store);
    const r = await createThesis(deps, "HYPE grinds higher into the unlock; out below $35 or BTC under $79.2K");
    if (!r.ok) throw new Error(r.error);
    const t = r.thesis;
    expect(t.assets).toEqual(["HYPE", "BTC"]);
    expect(t.claims.map((c) => c.status)).toEqual(["supported", "supported", "supported", "unknown"]);
    expect(t.claims[0]!.evidence).toMatchObject({ value: 15, source: { label: "snapshot" } });
    expect(t.invalidation.map((i) => i.status)).toEqual(["clear", "clear", undefined]);
    expect(t.invalidation[0]!.check).toEqual({ kind: "price_vs_level", asset: "HYPE", op: "<", level: 35 });
    expect(t.checkedAt).toBe(NOW);
    expect(t.trace?.dropped).toBe(1);
    expect(await store.listTheses()).toHaveLength(1);
  });

  test("recheck re-evaluates saved checks without calling the model", async () => {
    const { store, deps, makes } = setup();
    await seed(store);
    const r = await createThesis(deps, "HYPE grinds higher; out below $35 or BTC under $79.2K");
    if (!r.ok) throw new Error(r.error);
    const calls = makes();
    // Price breaks $35 and funding turns negative.
    await store.insertSnapshots([snap("HYPE", 0, { price: 33, oiUsd: 900_000, funding: -0.0002 })]);
    const t = await checkThesis(deps, r.thesis.id);
    expect(makes()).toBe(calls);
    expect(t!.claims.map((c) => c.status)).toEqual(["contradicted", "contradicted", "supported", "unknown"]);
    expect(t!.invalidation[0]!.status).toBe("triggered");
    expect(await checkThesis(deps, "00000000-0000-4000-8000-999999999999")).toBeNull();
  });

  test("recheckAll rechecks every thesis, not only flagged assets", async () => {
    const { store, deps } = setup();
    await seed(store);
    const a = await createThesis(deps, "HYPE thesis");
    const other = await store.insertThesis({ text: "SOL", assets: ["SOL"], claims: [], invalidation: [], wrongIf: [], checkedAt: null });
    const out = await recheckAll(deps);
    expect(out.map((t) => t.id).sort()).toEqual([a.ok ? a.thesis.id : "", other.id].sort());
    expect((await store.getThesis(other.id))!.checkedAt).toBe(NOW);
  });

  test("history grows per check, is capped, and alerts once per transition", async () => {
    const { store, deps } = setup();
    await seed(store);
    const sent: string[] = [];
    const notifier: Notifier = { channels: ["t"], send: async (a) => (sent.push(`${a.title}\n${a.body}`), ["t"]) };
    const d = { ...deps, notifier };
    const r = await createThesis(d, "HYPE grinds higher; out below $35");
    if (!r.ok) throw new Error(r.error);
    expect(r.thesis.history).toHaveLength(1);
    await checkThesis(d, r.thesis.id);
    expect(sent).toEqual([]); // unchanged: no alert
    await store.insertSnapshots([snap("HYPE", 0, { price: 33, funding: -0.0002 })]);
    const t = await checkThesis(d, r.thesis.id);
    expect(t!.history).toHaveLength(3);
    expect(t!.history!.at(-1)!.checks[1]).toEqual({ status: "contradicted", value: -0.0002 });
    // OI and funding claims (supported -> contradicted) + invalidation (clear -> triggered)
    expect(sent).toHaveLength(3);
    expect(sent[1]).toContain("Premise no longer holds: Funding stays positive");
    expect(sent[1]).toContain("HYPE funding positive: now -0.0002 (snapshot,");
    expect(sent[2]).toContain("Premise no longer holds: HYPE below $35");
    expect(sent.join("")).not.toMatch(/consider|close|sell|buy/i);
    await checkThesis(d, r.thesis.id);
    expect(sent).toHaveLength(3); // state unchanged: no repeat

    await store.updateThesis(r.thesis.id, { history: Array.from({ length: HISTORY_CAP }, () => ({ ts: NOW, checks: [] })) });
    expect((await checkThesis(d, r.thesis.id))!.history).toHaveLength(HISTORY_CAP);
  });
});
