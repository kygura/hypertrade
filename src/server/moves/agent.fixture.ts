import type { AgentRecord } from "../../shared/agentRecords.js";
import { MoveDetailSchema, type Attribution, type MoveDetail, type MoveRow } from "../../shared/moves.js";

// Test support for the agent watch (triage, agent, grade, loop, routes): code-shaped moves rows and records.

export const T0 = Date.UTC(2026, 10, 11, 12);
export const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

export function attribution(over: Partial<Attribution> = {}): Attribution {
  return {
    window: "24h", from: iso(T0 - 24 * HOUR), to: iso(T0), hours: 24,
    totalPct: 7.2, btcPct: 0.8, ethPct: 0.1, sectorPct: 0.1, residualPct: 6.2,
    residualFlowPct: 0, residualNewsPct: 0, residualOtherPct: 6.2, flowHours: 0, newsHours: 0,
    residualZ: 3.1, sigma1hPct: 0.4, r2: 0.55, estimation: { from: iso(T0 - 192 * HOUR), to: iso(T0 - 24 * HOUR), n: 168 }, betas: [],
    ...over,
  };
}

export function row(coin: string, over: Partial<MoveRow> = {}): MoveRow {
  return {
    coin, sector: null, mark: 10, dayNtlVlm: 5e7, attribution: attribution(), attributionReason: null,
    positioning: { fundingHourly: 0.00001, fundingAprPct: 8.76, fundingZ: 0.5, fundingN: 336, premiumBps: 1, oiUsd: 2e7, oiChg24hPct: 4, oiChg72hPct: 6, oiN: 200, oiToVolume: 0.4, checks: [], longMet: 0, shortMet: 0, of: 4 },
    liq: { state: { state: "ok", reason: null }, nearestLong: null, nearestShort: null, sigma24hPct: 4, longSigmas: null, shortSigmas: null, coverageRatio: 0.3 },
    attention: { state: { state: "ok", reason: null }, news24h: 0, news72h: 0, newsDailyMean7d: 0.2, newsRatio: 0, mentions24h: null, mentionsChg24hPct: null, mentionsAsOf: null, sectorId: null, sectorStage: null },
    setups: [], opportunityId: null,
    ...over,
  };
}

const layer = { state: "ok" as const, reason: null };
export function detail(coin = "SOL", over: Partial<MoveDetail> = {}): MoveDetail {
  return MoveDetailSchema.parse({
    ...row(coin), state: "ok", reason: null, asOf: iso(T0), window: "24h",
    layers: { beta: layer, flow: layer, attention: layer, liq: layer, agents: layer },
    series: [], headlines: [{ title: "SOL ecosystem fund announced", firstSeen: iso(T0 - 2 * HOUR), url: null, assets: ["SOL"] }], record: null,
    ...over,
  });
}

export function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "rec-1", coin: "SOL", createdAt: iso(T0), trigger: "triage",
    inputs: { window: "24h", residualPct: 6.2, residualZ: 3.1, totalPct: 7.2, markAtCreate: 100, btcAtCreate: 60000, asOf: iso(T0) },
    claim: "A token unlock hit the book.", assets: ["SOL"], direction: "long", horizonHours: 24, layer: "forced_flow",
    falsifier: { level: 95, side: "below", text: "a trade below 95 breaks it" }, sources: [],
    status: "open", grade: null, model: "scripted", promptVersion: "moves-agent-v1", dropped: 0, error: null,
    ...over,
  };
}
