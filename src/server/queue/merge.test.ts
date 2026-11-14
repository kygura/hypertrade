import { describe, expect, test } from "bun:test";
import type { AgentRecord, TriageItem } from "../../shared/agentRecords.js";
import type { Opportunity } from "../../shared/platform.js";
import { QueueResponseSchema } from "../../shared/queue.js";
import type { RadarCall } from "../../shared/radar.js";
import { mergeQueue, movesPart, opportunityPart, radarPart, type MergeInput } from "./merge.js";

const DAY = "2026-11-11";
const t = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 11, h, m)).toISOString();
const NOW = new Date(t(12));

const triage = (coin: string, h: number, over: Partial<TriageItem> = {}): TriageItem => ({
  id: `${DAY}:${coin}`, day: DAY, coin, reason: "residual +6.2% · z +3.1 · 24h · no news in window", score: 1.24, residualZ: 3.1,
  surfacedAt: t(h), dismissedAt: null, recordId: null, ...over,
});

let n = 0;
const opp = (coin: string, h: number, over: Partial<Opportunity> = {}): Opportunity => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, coin, direction: "long", setupKind: "crowded_short", tradeType: "directional",
  status: "ready", score: 3, scoreVersion: "v1", netEdgeBps: 42.4, grossEdgeBps: 50, edgeBasis: "unvalidated", costs: null, tags: [],
  liquidityTier: 1, regime: "trend", invalidation: "15m close below 180", entryPx: 182, stopPx: 178, targetPx: 190, invalidationPx: 178,
  createdAt: t(h), updatedAt: t(h), statusChangedAt: t(h), snoozedUntil: null, dedupeKey: `${coin}|long|crowded_short`, ...over,
});

const THESIS = "Unlock news pulls supply forward while the crowd is still short into the event";
const call = (market: string, h: number, over: Partial<RadarCall> = {}): RadarCall => ({
  id: `${DAY}-1-${market}`, date: DAY, at: t(h), market, stance: "ride", direction: "long", kind: "catalyst", thesis: THESIS,
  cause_url: "https://example.com/a", cause_date: DAY, kill_price: 31.2, kill_if: "daily close below 31.2", mark: 33, btc: 60000,
  rel: {}, killed_at: null, ...over,
});

const record = (id: string, coin: string, h: number): AgentRecord => ({
  id, coin, createdAt: t(h), trigger: "triage",
  inputs: { window: "24h", residualPct: 6.2, residualZ: 3.1, totalPct: 4.5, markAtCreate: 10, btcAtCreate: 60000, asOf: t(h) },
  claim: "Unlock of 3% of supply hit the order book.", assets: [coin], direction: "short", horizonHours: 24, layer: "forced_flow",
  falsifier: null, sources: [], status: "open", grade: null, model: "m", promptVersion: "moves-agent-v1", dropped: 0, error: null,
});

const input = (over: Partial<MergeInput> = {}): MergeInput => ({
  day: DAY, now: NOW, cap: 8, guest: false, triage: { ok: [] }, records: [], opportunities: { ok: [] }, radar: { ok: [] }, dismissals: [], ...over,
});

describe("mergeQueue", () => {
  test("a ready extremes take (no costs, no target, no net edge, its own kind and score version) is listed like any ready opportunity; its severity does not outrank", () => {
    const take = opp("WIF", 5, {
      setupKind: "oi_flush", scoreVersion: "extremes-1", score: 9.5, netEdgeBps: null, grossEdgeBps: null, costs: null, targetPx: null, regime: "unknown",
      tags: ["extreme", "oi_flush"], liquidityTier: 3, dedupeKey: "WIF|long|oi_flush",
    });
    const q = QueueResponseSchema.omit({ agentRuns: true, agentCap: true, agentBlockedReason: true, watched: true, freshness: true }).parse(
      mergeQueue(input({ triage: { ok: [triage("SOL", 3, { score: 1.5 })] }, opportunities: { ok: [take] } })),
    );
    expect(q.items.map((i) => i.coin)).toEqual(["SOL", "WIF"]);
    expect(q.items[1]!.parts).toEqual([{ source: "opportunity", ref: take.id, direction: "long", reason: "oi_flush long · ready", score: 1, at: t(5), actedAt: null, href: `/feed?id=${take.id}` }]);
    expect(q.sources.opportunity).toEqual({ state: "ok", reason: null, count: 1 });
  });

  test("three sources on one coin make one item with three parts, ranked above weaker single-source items", () => {
    const q = mergeQueue(input({
      triage: { ok: [triage("SOL", 3), triage("WIF", 1, { score: 1.1 })] },
      opportunities: { ok: [opp("SOL", 4)] },
      radar: { ok: [call("SOL", 2)] },
    }));
    expect(q.items.map((i) => i.coin)).toEqual(["SOL", "WIF"]);
    const sol = q.items[0]!;
    expect(sol.parts.map((p) => p.source)).toEqual(["moves", "opportunity", "radar"]);
    expect(sol).toMatchObject({ id: `${DAY}:SOL`, state: "new", score: 1.24, firstAt: t(2), lastAt: t(4), href: "/coin/SOL", reason: triage("SOL", 3).reason });
    expect(sol.parts[1]).toMatchObject({ reason: "crowded_short long · ready · net 42 bps", score: 1, actedAt: null });
    expect(sol.parts[2]).toMatchObject({ reason: "ride long · catalyst · kill 31.2", direction: "long" });
    expect(q.sources).toEqual({ moves: { state: "ok", reason: null, count: 2 }, opportunity: { state: "ok", reason: null, count: 1 }, radar: { state: "ok", reason: null, count: 1 } });
  });

  test("cap lists the strongest regardless of arrival order; the weakest is over the cap", () => {
    const q = mergeQueue(input({ cap: 2, triage: { ok: [triage("A", 1, { score: 1.5 }), triage("B", 2, { score: 1.2 }), triage("C", 3, { score: 5 })] } }));
    expect(q.items.map((i) => i.coin)).toEqual(["C", "A"]);
    expect(q.overCap).toBe(1);
    expect(q.sources.moves.count).toBe(3);
  });

  test("slot ties fall back to agreeing sources, then earlier firstAt, then coin", () => {
    const ties = (c: number, ...cs: string[]) => mergeQueue(input({ cap: c, triage: { ok: cs.map((x, i) => triage(x, 5 - i, { score: 1 })) } }));
    // same score and one part: earliest firstAt wins (C at 3h, B at 4h, A at 5h, so A is over the cap); coin breaks equal times
    expect(ties(2, "A", "B", "C").items.map((i) => i.coin)).toEqual(["C", "B"]);
    const same = mergeQueue(input({ cap: 1, triage: { ok: [triage("B", 1, { score: 1 }), triage("A", 1, { score: 1 })] } }));
    expect(same.items.map((i) => i.coin)).toEqual(["A"]);
    // equal score: the coin with two agreeing sources beats an earlier single-source one
    const parts = mergeQueue(input({ cap: 1, triage: { ok: [triage("A", 1, { score: 1 }), triage("B", 5, { score: 1 })] }, radar: { ok: [call("B", 6)] } }));
    expect(parts.items.map((i) => i.coin)).toEqual(["B"]);
  });

  test("dismissed and acted items still count and compete on score", () => {
    const dismissals = [{ day: DAY, coin: "A", dismissedAt: t(9) }] as MergeInput["dismissals"];
    const q = mergeQueue(input({ cap: 2, dismissals, triage: { ok: [triage("A", 1, { score: 3 }), triage("B", 2, { score: 2 }), triage("C", 3, { score: 1.5 })] } }));
    expect(q.items.map((i) => [i.coin, i.state])).toEqual([["B", "new"], ["A", "dismissed"]]);
    expect(q.overCap).toBe(1);
  });

  test("a queue dismissal hides the item until a newer part arrives; a triage dismissal alone also dismisses", () => {
    const dismissals = [{ day: DAY, coin: "SOL", dismissedAt: t(5) }];
    const hidden = mergeQueue(input({ triage: { ok: [triage("SOL", 3)] }, dismissals }));
    expect(hidden.items[0]).toMatchObject({ state: "dismissed", dismissedAt: t(5) });
    const back = mergeQueue(input({ triage: { ok: [triage("SOL", 3)] }, opportunities: { ok: [opp("SOL", 6)] }, dismissals }));
    expect(back.items[0]).toMatchObject({ state: "new", dismissedAt: t(5) });
    const byTriage = mergeQueue(input({ triage: { ok: [triage("SOL", 3, { dismissedAt: t(4) })] } }));
    expect(byTriage.items[0]).toMatchObject({ state: "dismissed", dismissedAt: t(4) });
    const latest = mergeQueue(input({ triage: { ok: [triage("SOL", 3, { dismissedAt: t(7) })] }, dismissals }));
    expect(latest.items[0]!.dismissedAt).toBe(t(7));
  });

  test("an opportunity approved or rejected today is acted and listed after new items; a ready one wins its slot", () => {
    const q = mergeQueue(input({
      triage: { ok: [triage("WIF", 5)] },
      opportunities: { ok: [
        opp("SOL", 1, { status: "approved", statusChangedAt: t(2) }),
        opp("ETH", 1, { status: "rejected", statusChangedAt: t(2) }),
        opp("BTC", 1, { status: "approved", statusChangedAt: new Date(Date.UTC(2026, 10, 10, 20)).toISOString() }), // decided yesterday
        opp("HYPE", 2, { status: "rejected", statusChangedAt: t(3) }),
        opp("HYPE", 1),
      ] },
    }));
    expect(q.items.map((i) => [i.coin, i.state])).toEqual([["WIF", "new"], ["HYPE", "new"], ["ETH", "acted"], ["SOL", "acted"]]); // WIF scores 1.24 > 1
    expect(q.items.find((i) => i.coin === "SOL")!.parts[0]).toMatchObject({ actedAt: t(2), reason: "crowded_short long · approved · net 42 bps" });
    expect(q.items[1]!.parts[0]!.reason).toContain("ready");
  });

  test("a guest gets no record and no radar; a signed-in user gets the triage item's record, else the newest of today", () => {
    const records = [record("r1", "SOL", 4), record("r2", "SOL", 6), record("r3", "WIF", 5)];
    const sources = { triage: { ok: [triage("SOL", 3, { recordId: "r1" }), triage("WIF", 3)] }, radar: { ok: [call("HYPE", 2)] }, records };
    const guest = mergeQueue(input({ ...sources, guest: true }));
    expect(guest.items.map((i) => i.record)).toEqual([null, null]);
    expect(guest.sources.radar).toEqual({ state: "unavailable", reason: "sign in required", count: 0 });
    const user = mergeQueue(input(sources));
    expect(Object.fromEntries(user.items.map((i) => [i.coin, i.record?.id ?? null]))).toEqual({ SOL: "r1", WIF: "r3", HYPE: null });
  });

  test("a record from late yesterday shows on today's item; one older than 24 h does not", () => {
    const sources = { triage: { ok: [triage("SOL", 3), triage("WIF", 3)] }, records: [record("r1", "SOL", -1), record("r2", "WIF", -13)] };
    const q = mergeQueue(input(sources));
    expect(Object.fromEntries(q.items.map((i) => [i.coin, i.record?.id ?? null]))).toEqual({ SOL: "r1", WIF: null });
  });

  test("one source unavailable: the others still merge and its reason is stated", () => {
    const q = mergeQueue(input({ triage: { unavailable: "needs the always-on server" }, opportunities: { ok: [opp("SOL", 1)] }, radar: { unavailable: "radar files not deployed" } }));
    expect(q.items.map((i) => i.coin)).toEqual(["SOL"]);
    expect(q.sources.moves).toEqual({ state: "unavailable", reason: "needs the always-on server", count: 0 });
    expect(q.sources.radar.reason).toBe("radar files not deployed");
  });

  test("radar: killed calls and calls older than yesterday are left out", () => {
    const q = mergeQueue(input({ radar: { ok: [
      call("HYPE", 2, { killed_at: DAY }),
      call("ETH", 2, { date: "2026-11-09", id: "old" }),
      call("SOL", 2, { date: "2026-11-10", at: "not a time", id: "y" }),
    ] } }));
    expect(q.items.map((i) => i.coin)).toEqual(["SOL"]);
    expect(q.items[0]!.firstAt).toBe("2026-11-10T00:00:00.000Z");
  });

  test("every output parses with the shared schema; reasons carry no thesis text", () => {
    const q = mergeQueue(input({
      triage: { ok: [triage("SOL", 3), triage("xyz:TSLA", 4)] }, opportunities: { ok: [opp("SOL", 4, { netEdgeBps: null })] },
      radar: { ok: [call("SOL", 2), call("HYPE", 5, { kill_price: 0.000123456789, stance: "fade", direction: "short" })] },
      records: [record("r1", "SOL", 4)], dismissals: [{ day: DAY, coin: "HYPE", dismissedAt: t(6) }],
    }));
    const full = QueueResponseSchema.parse({ ...q, agentRuns: 0, agentCap: 6, agentBlockedReason: null, watched: 0, freshness: { movesRun: null, triage: null } });
    expect(full.items).toHaveLength(3);
    const reasons = full.items.flatMap((i) => [i.reason, ...i.parts.map((p) => p.reason)]);
    for (const r of reasons) expect(r).not.toContain("Unlock");
    expect(reasons).toContain("fade short · catalyst · kill 0.000123457");
    expect(reasons).toContain("crowded_short long · ready");
    expect(full.items.find((i) => i.coin === "xyz:TSLA")!.href).toBe("/coin/xyz%3ATSLA");
  });

  test("cap 0 lists nothing and counts everything over the cap", () => {
    const q = mergeQueue(input({ cap: 0, triage: { ok: [triage("A", 1), triage("B", 2)] }, radar: { ok: [call("C", 3)] } }));
    expect(q.items).toEqual([]);
    expect(q.overCap).toBe(3);
  });
});

describe("parts", () => {
  test("movesPart keeps the triage facts; opportunityPart drops what is neither ready nor decided today", () => {
    expect(movesPart(triage("SOL", 3))).toMatchObject({ source: "moves", ref: `${DAY}:SOL`, direction: null, score: 1.24, at: t(3), href: "/moves?coin=SOL" });
    const dayStart = new Date(`${DAY}T00:00:00Z`);
    expect(opportunityPart(opp("SOL", 1, { status: "calculated" }), dayStart)).toBeNull();
    expect(opportunityPart(opp("SOL", 1, { status: "expired" }), dayStart)).toBeNull();
    expect(opportunityPart(opp("SOL", 1), dayStart)!.href).toStartWith("/feed?id=");
    expect(radarPart(call("SOL", 2)).at).toBe(t(2));
  });
});
