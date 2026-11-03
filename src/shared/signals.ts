import type { PredictedFunding } from "./hl-client.js";
import { premiumSentence, signed, usdShort, venueApr } from "./marketRead.js";
import type { AssetCtx } from "./types.js";

// Ranked "what is unusual right now" cards for the landing and coin pages, from the live HL
// universe alone. Pure. Severity is a robust z-score across the universe; each coin shows only
// its strongest signal. Facts and the rule that fired, never a verdict.

export const SIGNAL = {
  /** Universe floors, shared with the radar scan: below them a print is noise. */
  minVolUsd: 1_000_000,
  minOiUsd: 1_000_000,
  fundingAprAbs: 50,
  premiumBpsAbs: 50,
  /** Robust z for an outsized 24h move or turnover. */
  zMin: 2.5,
  /** HL APR minus Binance APR, percentage points. */
  venueGapPts: 30,
  top: 6,
} as const;

export type SignalKind = "funding_extreme" | "basis" | "outsized_move" | "turnover" | "at_cap" | "venue_gap";

export interface Signal {
  coin: string;
  kind: SignalKind;
  severity: number;
  sentence: string;
  why: string;
  /** When the signal fires, in words. */
  rule: string;
  evidence: { label: string; value: string }[];
}

export interface SignalInput {
  ctxs: AssetCtx[];
  predicted?: Map<string, PredictedFunding[]>;
  atCap?: Iterable<string>;
}

const HOURS_PER_YEAR = 24 * 365;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** |x − median| / (1.4826 × MAD) for each x, signed; null for every x when the spread is zero. */
export function robustZ(xs: number[]): (number | null)[] {
  if (xs.length === 0) return [];
  const med = median(xs);
  const scale = 1.4826 * median(xs.map((x) => Math.abs(x - med)));
  return xs.map((x) => (scale > 0 ? (x - med) / scale : null));
}

/** 24h notional volume over open interest in USD; null without OI. */
export function turnover(c: AssetCtx): number | null {
  const oiUsd = c.openInterest * c.markPx;
  return oiUsd > 0 ? c.dayNtlVlm / oiUsd : null;
}

const KIND_ORDER: SignalKind[] = ["funding_extreme", "venue_gap", "basis", "at_cap", "turnover", "outsized_move"];
const rules: Record<SignalKind, string> = {
  funding_extreme: `fires when |funding| ≥ ${SIGNAL.fundingAprAbs}% APR`,
  basis: `fires when |premium| ≥ ${SIGNAL.premiumBpsAbs} bp`,
  outsized_move: `fires when the 24h change is ≥ ${SIGNAL.zMin} × the typical spread from the median perp (robust z: distance from the median in median-absolute-deviation units)`,
  turnover: `fires when 24h volume / open interest is ≥ ${SIGNAL.zMin} × the typical spread above the median perp (robust z)`,
  at_cap: "fires when Hyperliquid lists the coin at its open-interest cap",
  venue_gap: `fires when HL funding differs from Binance by ≥ ${SIGNAL.venueGapPts} pts APR, each normalised by its own interval`,
};

/** Severity from a robust z; at the threshold when the universe has no spread to score against. */
const sev = (z: number | null) => (z == null ? SIGNAL.zMin : Math.abs(z));
const pct0 = (x: number) => `${signed(x, 0)}%`;

/** Strongest signal per coin across the floored universe, most severe first, at most `top`. */
export function deriveSignals({ ctxs, predicted, atCap }: SignalInput, top: number = SIGNAL.top): Signal[] {
  const capped = new Set(atCap ?? []);
  const u = ctxs.filter((c) => !c.isDelisted && c.markPx > 0 && c.openInterest * c.markPx >= SIGNAL.minOiUsd && c.dayNtlVlm >= SIGNAL.minVolUsd);
  if (u.length === 0) return [];

  const apr = u.map((c) => c.funding * HOURS_PER_YEAR * 100);
  const bp = u.map((c) => c.premium * 1e4);
  const chg = u.map((c) => c.dayChange * 100);
  const turn = u.map((c) => turnover(c) ?? 0);
  const zApr = robustZ(apr);
  const zBp = robustZ(bp);
  const zChg = robustZ(chg);
  const zTurn = robustZ(turn);
  const medApr = median(apr);
  const medBp = median(bp);
  const medChg = median(chg);
  const medTurn = median(turn);

  const bin = u.map((c) => predicted?.get(c.name)?.find((p) => p.venue === "BinPerp"));
  const gapIdx = u.flatMap((_, i) => (bin[i] ? [i] : []));
  const gaps = gapIdx.map((i) => apr[i]! - venueApr(bin[i]!) * 100);
  const zGaps = robustZ(gaps);
  const zGap = new Map(gapIdx.map((i, k) => [i, zGaps[k]!]));

  const best = new Map<string, Signal>();
  const offer = (s: Signal) => {
    const cur = best.get(s.coin);
    if (!cur || s.severity > cur.severity || (s.severity === cur.severity && KIND_ORDER.indexOf(s.kind) < KIND_ORDER.indexOf(cur.kind))) best.set(s.coin, s);
  };

  u.forEach((c, i) => {
    const coin = c.name;
    const a = apr[i]!;
    if (Math.abs(a) >= SIGNAL.fundingAprAbs) {
      const side = a > 0 ? "longs" : "shorts";
      const beyond = apr.filter((x) => (a > 0 ? x < a : x > a)).length / apr.length;
      offer({
        coin,
        kind: "funding_extreme",
        severity: sev(zApr[i]!),
        sentence: `${coin} ${side} pay ${Math.round(Math.abs(a))}% a year to hold, more than ${Math.floor(beyond * 100)}% of HL perps.`,
        why: a > 0 ? "Crowded longs bleed carry; if price stalls they are the ones forced out." : "Crowded shorts bleed carry; if price holds up they are the ones forced out.",
        rule: rules.funding_extreme,
        evidence: [
          { label: "Funding", value: `${pct0(a)} APR` },
          { label: "Median perp", value: `${pct0(medApr)} APR` },
        ],
      });
    }

    const b = bp[i]!;
    if (Math.abs(b) >= SIGNAL.premiumBpsAbs) {
      offer({
        coin,
        kind: "basis",
        severity: sev(zBp[i]!),
        sentence: premiumSentence(coin, c.premium),
        why: b > 0 ? "Leverage, not spot, is carrying the price." : "Perp sellers are pressing harder than spot.",
        rule: rules.basis,
        evidence: [
          { label: "Premium", value: `${signed(Math.round(b), 0)} bp` },
          { label: "Median perp", value: `${signed(Math.round(medBp), 0)} bp` },
        ],
      });
    }

    const zc = zChg[i]!;
    if (zc != null && Math.abs(zc) >= SIGNAL.zMin) {
      offer({
        coin,
        kind: "outsized_move",
        severity: Math.abs(zc),
        sentence: `${coin} ${pct0(chg[i]!)} while the median perp is ${pct0(medChg)}.`,
        why: "A move this far from the pack is about this coin, not the whole market.",
        rule: rules.outsized_move,
        evidence: [
          { label: "24h", value: pct0(chg[i]!) },
          { label: "Median perp", value: pct0(medChg) },
          { label: "vs normal", value: `${Math.abs(zc).toFixed(1)}x` },
        ],
      });
    }

    const zt = zTurn[i]!;
    if (zt != null && zt >= SIGNAL.zMin) {
      offer({
        coin,
        kind: "turnover",
        severity: zt,
        sentence: `${coin} traded ${turn[i]!.toFixed(1)}x its open interest in 24h; the median perp trades ${medTurn.toFixed(1)}x.`,
        why: "Positions are being churned: a flush or a new crowd arriving.",
        rule: rules.turnover,
        evidence: [
          { label: "Turnover", value: `${turn[i]!.toFixed(1)}x` },
          { label: "Median perp", value: `${medTurn.toFixed(1)}x` },
          { label: "24h volume", value: usdShort(c.dayNtlVlm) },
        ],
      });
    }

    if (capped.has(coin)) {
      offer({
        coin,
        kind: "at_cap",
        severity: SIGNAL.zMin,
        sentence: `${coin} is at its open-interest cap: new positions can't open, only close.`,
        why: "Hyperliquid caps open interest per coin; the cap lifts as positions close.",
        rule: rules.at_cap,
        evidence: [
          { label: "OI", value: usdShort(c.openInterest * c.markPx) },
          { label: "Funding", value: `${pct0(a)} APR` },
        ],
      });
    }

    const binance = bin[i];
    if (binance) {
      const bApr = venueApr(binance) * 100;
      const gap = a - bApr;
      if (Math.abs(gap) >= SIGNAL.venueGapPts) {
        offer({
          coin,
          kind: "venue_gap",
          severity: sev(zGap.get(i) ?? null),
          sentence: `${coin} funding on HL is ${Math.round(Math.abs(gap))} pts APR ${gap > 0 ? "above" : "below"} Binance.`,
          why: gap > 0 ? "HL longs pay more to hold the same trade than Binance longs." : "HL shorts pay more to hold the same trade than Binance shorts.",
          rule: rules.venue_gap,
          evidence: [
            { label: "HL", value: `${pct0(a)} APR` },
            { label: "Binance", value: `${pct0(bApr)} APR` },
            { label: "Gap", value: `${Math.round(Math.abs(gap))} pts` },
          ],
        });
      }
    }
  });

  return [...best.values()]
    .sort((x, y) => y.severity - x.severity || KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || (x.coin < y.coin ? -1 : 1))
    .slice(0, top);
}
