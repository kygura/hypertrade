import type { SetupId } from "../../shared/setups.js";
import { BOARD, type BoardRow } from "./board.js";

// Tripwires: the commonplace setups as hard, one-dimensional thresholds over a
// board row (docs/fallback-routine.md § Tripwires). Pure. A hit is a fact
// about thresholds, not a prediction; a near-miss is a hit missing one numeric
// condition. The model reads both and must either write a hit up as a setup or
// say why it passes. The thresholds are starting points for the ledger and the
// Lab event study to grade, not claims of an edge.

export const TRIPWIRES = {
  /** Annualised funding treated as crowded long (~3× HL's 10.95% neutral). */
  crowdedLongAnnPct: 30,
  /** Annualised funding at which shorts are paying. */
  shortsPayingAnnPct: -10,
  /** OI build in contracts over 24 h that counts as fresh positioning. */
  oiBuildPct: 3,
  /** OI drop over 24 h that reads as a flush. */
  oiFlushPct: -8,
  /** 1 d range position treated as pressed into the high. */
  rangeHighPos: 0.8,
  /** 24 h drop, in 1 d ATRs, that reads as a washout. */
  washoutAtr: -1.5,
  /** Breakout bar volume vs the window mean. */
  breakoutVolRatio: 1.3,
  /** Distance from the 1 d SMA20, in ATRs, that counts as a pullback to it. */
  pullbackAtr: 0.75,
  /** A near-miss's one failing condition sits within this many limit-widths of its limit (max(|limit|, 1)). */
  maxNearGap: 1,
} as const;

export interface Condition {
  label: string;
  value: number | string | null;
  op: ">=" | "<=" | "<" | ">" | "=" | "≠";
  limit: number | string;
  pass: boolean;
}

export interface TripwireRead {
  setup_id: SetupId;
  asset: string;
  direction: "long" | "short";
  status: "hit" | "near";
  conditions: Condition[];
  /** Near only: how far the one failing numeric condition is from its limit, relative to the limit. */
  gap: number | null;
}

type Spec = [label: string, value: number | string | null, op: Condition["op"], limit: number | string];

function cond([label, value, op, limit]: Spec): Condition {
  let pass = false;
  if (value !== null) {
    if (op === "=") pass = value === limit;
    else if (op === "≠") pass = value !== limit;
    else if (typeof value === "number" && typeof limit === "number")
      pass = op === ">=" ? value >= limit : op === "<=" ? value <= limit : op === ">" ? value > limit : value < limit;
  }
  return { label, value, op, limit, pass };
}

const inAtr = (pctMove: number | null, atrPct: number | null | undefined) => (pctMove === null || !atrPct ? null : Math.round((pctMove / atrPct) * 100) / 100);

interface Template {
  id: SetupId;
  direction: "long" | "short";
  specs(r: BoardRow): Spec[];
}

const T = TRIPWIRES;
const neutral = BOARD.baselineFundingAnnPct;

export const TEMPLATES: Template[] = [
  {
    id: "funding_fade",
    direction: "short",
    specs: (r) => [
      ["funding ann %", r.pos.fundingAnnPct, ">=", T.crowdedLongAnnPct],
      ["OI 24h %", r.pos.oiChg24hPct, ">=", T.oiBuildPct],
      ["1d range position", r.tf["1d"]?.rangePos ?? null, ">=", T.rangeHighPos],
      ["|24h move| in 1d ATR", inAtr(r.pos.ret24hPct === null ? null : Math.abs(r.pos.ret24hPct), r.tf["1d"]?.atrPct), "<=", 1],
    ],
  },
  {
    id: "negative_funding_build",
    direction: "long",
    specs: (r) => [
      ["funding ann %", r.pos.fundingAnnPct, "<=", T.shortsPayingAnnPct],
      ["OI 24h %", r.pos.oiChg24hPct, ">=", T.oiBuildPct],
      ["24h move in 1d ATR", inAtr(r.pos.ret24hPct, r.tf["1d"]?.atrPct), ">=", -1],
    ],
  },
  {
    id: "post_liquidation_reclaim",
    direction: "long",
    specs: (r) => [
      ["24h move in 1d ATR", inAtr(r.pos.ret24hPct, r.tf["1d"]?.atrPct), "<=", T.washoutAtr],
      ["OI 24h %", r.pos.oiChg24hPct, "<=", T.oiFlushPct],
      ["funding ann %", r.pos.fundingAnnPct, "<=", neutral],
    ],
  },
  ...(["long", "short"] as const).map(
    (direction): Template => ({
      id: "range_breakout",
      direction,
      specs: (r) => [
        ["1d breakout", r.tf["1d"]?.breakout ?? null, "=", direction === "long" ? "up" : "down"],
        ["OI 24h %", r.pos.oiChg24hPct, ">=", 0],
        ["1d volume ratio", r.tf["1d"]?.volRatio ?? null, ">=", T.breakoutVolRatio],
        direction === "long" ? ["funding ann %", r.pos.fundingAnnPct, "<", T.crowdedLongAnnPct] : ["funding ann %", r.pos.fundingAnnPct, ">", T.shortsPayingAnnPct],
      ],
    }),
  ),
  ...(["long", "short"] as const).map(
    (direction): Template => ({
      id: "failed_breakout",
      direction,
      specs: (r) => {
        const want = direction === "short" ? "high" : "low";
        const sweep = r.tf["1d"]?.sweep === want ? "1d" : r.tf["4h"]?.sweep === want ? "4h" : null;
        return [
          [`sweep of the range ${want} (1d or 4h)`, sweep, "≠", "none"],
          direction === "short" ? ["funding ann %", r.pos.fundingAnnPct, ">=", neutral] : ["funding ann %", r.pos.fundingAnnPct, "<=", neutral],
          ["OI 24h %", r.pos.oiChg24hPct, ">=", 0],
        ];
      },
    }),
  ),
  ...(["long", "short"] as const).map(
    (direction): Template => ({
      id: "htf_pullback",
      direction,
      specs: (r) => {
        const want = direction === "long" ? "up" : "down";
        const dist = r.tf["1d"]?.vsSma20Atr;
        return [
          ["1w trend", r.tf["1w"]?.trend ?? null, "=", want],
          ["1d trend", r.tf["1d"]?.trend ?? null, "=", want],
          ["|mark − 1d SMA20| in ATR", dist === null || dist === undefined ? null : Math.abs(dist), "<=", T.pullbackAtr],
          direction === "long" ? ["funding ann %", r.pos.fundingAnnPct, "<", 25] : ["funding ann %", r.pos.fundingAnnPct, ">", T.shortsPayingAnnPct],
        ];
      },
    }),
  ),
];

/** Every hit, then the near-misses closest to their limit first (at most `maxNear`). */
export function evaluateTripwires(rows: BoardRow[], maxNear = 8): { hits: TripwireRead[]; near: TripwireRead[] } {
  const hits: TripwireRead[] = [];
  const near: TripwireRead[] = [];
  for (const r of rows) {
    for (const t of TEMPLATES) {
      const conditions = t.specs(r).map(cond);
      const failing = conditions.filter((c) => !c.pass);
      const base = { setup_id: t.id, asset: r.coin, direction: t.direction, conditions };
      if (!failing.length) hits.push({ ...base, status: "hit", gap: null });
      else if (failing.length === 1) {
        const f = failing[0]!;
        // Only a numeric miss is "near": a breakout that did not happen is not almost a breakout.
        if (typeof f.value === "number" && typeof f.limit === "number") {
          const gap = Math.round((Math.abs(f.value - f.limit) / Math.max(Math.abs(f.limit), 1)) * 100) / 100;
          if (gap <= T.maxNearGap) near.push({ ...base, status: "near", gap });
        }
      }
    }
  }
  near.sort((a, b) => a.gap! - b.gap! || (a.asset < b.asset ? -1 : 1));
  return { hits, near: near.slice(0, maxNear) };
}

export const tripwireKey = (t: { asset: string; setup_id: string; direction: string }) => `${t.asset}|${t.setup_id}|${t.direction}`;

/** "funding ann % 41.2 ≥ 30 ✓" style, for the prompt and the brief. */
export function formatTripwire(t: TripwireRead): string {
  const c = t.conditions.map((x) => `${x.label} ${x.value ?? "n/a"} ${x.op} ${x.limit} ${x.pass ? "✓" : "✗"}`).join("; ");
  return `${t.asset} ${t.setup_id} ${t.direction}: ${c}`;
}
