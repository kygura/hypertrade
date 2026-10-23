import type { SetupId } from "../../shared/setups.js";
import { numbersBacked } from "../intel/numbers.js";
import { sig, type BoardRow, type LevelKey } from "./board.js";
import type { ScanOutput, SetupDraft, SetupProposal, WatchItem } from "./schema.js";

// From the model's scan to priced proposals (docs/fallback-routine.md § Scan).
// Pure. The model names structure (which market, which side, which levels by
// key, why); code resolves every key to a price, computes the targets given in
// R, decides alignment with the weekly trend and the expiry, and drops text
// whose numbers are not on the board. The gate (gate.ts) then checks the
// result like any other proposal.

/** Days a plan stays open, by the bar its trigger is read on. All within GATE.maxDays.swing. */
export const EXPIRY_DAYS = { "4h": 3, "1d": 7, "1w": 10 } as const;

export interface ResolvedProposal extends SetupProposal {
  setup_id: SetupId | null;
  timeframe: SetupDraft["timeframe"];
  levels_source: "menu";
}

export type Resolution = { ok: true; proposal: ResolvedProposal; notes: string[] } | { ok: false; asset: string; direction: string; rule: string; detail: string };

const DAY = 86_400_000;

/** Weekly trend (daily when the market is too young for one) against the setup's direction. */
export function alignment(row: BoardRow, direction: "long" | "short"): "with" | "counter" {
  const trend = row.tf["1w"]?.trend ?? row.tf["1d"]?.trend ?? null;
  return (direction === "long" && trend === "down") || (direction === "short" && trend === "up") ? "counter" : "with";
}

/** `payload`: every number the model was shown (payloadNumbers of the prompt). */
export function resolveDraft(d: SetupDraft, row: BoardRow | undefined, now: Date, payload: number[]): Resolution {
  const fail = (rule: string, detail: string): Resolution => ({ ok: false, asset: d.asset, direction: d.direction, rule, detail });
  if (!row) return fail("unknown_asset", `${d.asset} is not on this run's board`);
  const atr = d.timeframe === "4h" ? row.tf["4h"]?.atr : row.tf["1d"]?.atr;
  const missing: string[] = [];
  const price = (ref: { level: LevelKey; atr?: number }): number => {
    const base = row.levels[ref.level];
    if (base === undefined) missing.push(ref.level);
    if (ref.atr && !atr) missing.push(`${d.timeframe} ATR`);
    return sig((base ?? 0) + (ref.atr ?? 0) * (atr ?? 0));
  };
  const a = price(d.entry.low);
  const b = price(d.entry.high);
  const entry = { low: Math.min(a, b), high: Math.max(a, b) };
  const invalidation = price(d.invalidation);
  const mid = (entry.low + entry.high) / 2;
  const risk = Math.abs(mid - invalidation);
  const sign = d.direction === "long" ? 1 : -1;
  const targets = d.targets.map((t) => (t.level === "R" ? sig(mid + sign * t.r! * risk) : price({ level: t.level, atr: t.atr })));
  if (missing.length) return fail("level_missing", `${d.asset} has no ${[...new Set(missing)].join(", ")} on the board (history too short or a gap)`);
  if ([entry.low, invalidation, ...targets].some((x) => !(x > 0))) return fail("levels_order", "a resolved level is not a positive price");

  // The draft's own resolved prices and multiples count as shown: a trigger may name the zone it resolved to.
  const own = [entry.low, entry.high, invalidation, ...targets, ...[d.entry.low, d.entry.high, d.invalidation, ...d.targets].flatMap((r) => [Math.abs(r.atr ?? 0), "r" in r ? (r.r ?? 0) : 0])];
  const shown = [...payload, ...own];
  for (const field of ["thesis", "trigger", "invalidation_reason"] as const)
    if (!numbersBacked(d[field], shown)) return fail("unbacked_number", `${field} cites a number that is not on the board`);

  const notes: string[] = [];
  const regime_alignment = alignment(row, d.direction);
  let conviction = d.conviction;
  if (regime_alignment === "counter" && conviction !== "low") {
    notes.push(`${d.asset} ${d.direction}: against the ${row.tf["1w"]?.trend ? "weekly" : "daily"} trend, conviction capped at low`);
    conviction = "low";
  }
  return {
    ok: true,
    notes,
    proposal: {
      asset: d.asset,
      direction: d.direction,
      horizon: "swing",
      thesis: d.thesis,
      regime_alignment,
      trigger: d.trigger,
      entry,
      invalidation,
      invalidation_reason: d.invalidation_reason,
      targets,
      conviction,
      evidence: d.evidence,
      expires_at: new Date(now.getTime() + EXPIRY_DAYS[d.timeframe] * DAY).toISOString(),
      setup_id: d.template,
      timeframe: d.timeframe,
      levels_source: "menu",
    },
  };
}

/** Watchlist items on board markets whose note and trigger condition cite only board numbers; the rest are dropped with a reason. */
export function checkWatchlist(items: WatchItem[], board: Map<string, BoardRow>, payload: number[]): { kept: WatchItem[]; dropped: string[] } {
  const kept: WatchItem[] = [];
  const dropped: string[] = [];
  for (const w of items) {
    if (!board.has(w.asset)) dropped.push(`${w.asset}: not on the board`);
    else if (!numbersBacked(`${w.note} ${w.arms}`, payload)) dropped.push(`${w.asset} ${w.kind}: cites a number that is not on the board`);
    else kept.push(w);
  }
  return { kept, dropped };
}

export const watchKey = (w: Pick<WatchItem, "asset" | "kind" | "skew">) => `${w.asset}|${w.kind}|${w.skew}`;

/** Tripwire hits the scan neither wrote up nor passed on with a reason. */
export function unanswered(hits: Array<{ asset: string; setup_id: SetupId; direction: string }>, scan: Pick<ScanOutput, "setups" | "passes">): string[] {
  const answered = new Set([
    ...scan.setups.map((s) => `${s.asset}|${s.template}|${s.direction}`),
    ...scan.passes.map((p) => `${p.asset}|${p.template}|${p.direction}`),
  ]);
  return hits.map((h) => `${h.asset}|${h.setup_id}|${h.direction}`).filter((k) => !answered.has(k));
}
