import type { Breadth } from "./flow.js";
import type { PredictedFunding } from "./hl-client.js";
import type { AssetCtx } from "./types.js";

// Plain-language reads of the live HL universe for the landing page and the coin page.
// Pure: every number in a sentence comes from the input, nothing is a verdict.

const HOURS_PER_YEAR = 24 * 365;

export interface ReadChip {
  label: string;
  value: string;
  /** How the value is computed. */
  title: string;
}

export interface MarketRead {
  sentences: string[];
  chips: ReadChip[];
}

export type FundingWord = "hot" | "mild" | "neutral" | "shorts paying";

/** Signed number with `d` decimals: "+1.4", "-0.6", "0". */
export function signed(x: number, d = 1): string {
  const s = Math.abs(x).toFixed(d);
  if (Number(s) === 0) return (0).toFixed(d);
  return `${x > 0 ? "+" : "-"}${s}`;
}

/** Short USD: "$310M", "$1.2B", "$850K". */
export function usdShort(x: number): string {
  const a = Math.abs(x);
  const body = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${Math.round(a / 1e6)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}K` : `${Math.round(a)}`;
  return `${x < 0 ? "-" : ""}$${body}`;
}

/**
 * Funding APR (percent) in words. 30% and -15% are the same lines classifyRegime
 * uses for hot long and hot short funding.
 */
export function fundingWord(aprPct: number): FundingWord {
  if (aprPct >= 30) return "hot";
  if (aprPct >= 10) return "mild";
  if (aprPct > -15) return "neutral";
  return "shorts paying";
}

/** Annualised funding as a fraction, normalised by the venue's own interval (Binance and Bybit are usually 8h). */
export function venueApr(p: PredictedFunding): number {
  return p.intervalHours > 0 ? (p.rate / p.intervalHours) * HOURS_PER_YEAR : 0;
}

export const VENUE_NAME: Record<string, string> = { HlPerp: "HL", BinPerp: "Binance", BybitPerp: "Bybit" };

/** "WIF perp trades 72 bp above its oracle." `premium` is a fraction of the oracle price. */
export function premiumSentence(coin: string, premium: number): string {
  const bp = Math.round(premium * 1e4);
  if (bp === 0) return `${coin} perp trades in line with its oracle.`;
  return `${coin} perp trades ${Math.abs(bp)} bp ${bp > 0 ? "above" : "below"} its oracle.`;
}

const FUNDING_CLAUSE: Record<FundingWord, string> = {
  hot: "longs are paying shorts, crowded",
  mild: "longs are paying shorts, mildly crowded",
  neutral: "close to neutral",
  "shorts paying": "shorts are paying longs, crowded short",
};

/** Three sentences and three chips from marketBreadth. */
export function marketRead(b: Breadth): MarketRead {
  if (b.sample === 0) return { sentences: ["No live perps to read right now."], chips: [] };
  const up = Math.round((b.advancingPct * b.sample) / 100);
  const sentences = [`${up} of the top ${b.sample} perps are up today (${Math.round(b.advancingPct)}%); the median perp is ${signed(b.medianDayChangePct)}%.`];
  if (b.btcDayChangePct != null && b.btcLeadPct != null) {
    const lead = Number(Math.abs(b.btcLeadPct).toFixed(1));
    const tail = lead === 0 ? "in line with the median perp" : b.btcLeadPct > 0 ? `BTC is leading alts by ${lead.toFixed(1)} pts` : `alts are leading by ${lead.toFixed(1)} pts`;
    sentences.push(`BTC ${signed(b.btcDayChangePct)}%: ${tail}.`);
  }
  const apr = b.oiWeightedFundingApr;
  sentences.push(`OI-weighted funding is ${signed(apr, 0)}% a year: ${FUNDING_CLAUSE[fundingWord(apr)]}.`);

  const chips: ReadChip[] = [
    { label: "ADVANCING", value: `${Math.round(b.advancingPct)}%`, title: `Share of the top ${b.sample} perps by open interest with a positive 24h change` },
  ];
  if (b.btcLeadPct != null) chips.push({ label: "BTC LEAD", value: `${signed(b.btcLeadPct)} pts`, title: "BTC 24h change minus the median perp's 24h change" });
  chips.push({ label: "FUNDING TILT", value: `${signed(apr, 0)}% APR`, title: `Hourly funding of the top ${b.sample} perps weighted by open interest in USD, times 8760` });
  return { sentences, chips };
}

export interface CoinReadInput {
  ctx: AssetCtx;
  /** Rank by open interest in USD on HL, 1-based; null when unknown. */
  rank: number | null;
  /** This coin's predicted fundings across venues. */
  predicted?: PredictedFunding[];
  atCap: boolean;
}

/** One line for the coin page header: "Funding +42% APR, hot (Binance 9%) · perp 12 bp over spot · OI $310M, #4 on HL · at OI cap". */
export function coinRead({ ctx, rank, predicted, atCap }: CoinReadInput): string {
  const apr = ctx.funding * HOURS_PER_YEAR * 100;
  const cex = predicted?.find((p) => p.venue === "BinPerp") ?? predicted?.find((p) => p.venue === "BybitPerp");
  const parts = [`Funding ${signed(apr, 0)}% APR, ${fundingWord(apr)}${cex ? ` (${VENUE_NAME[cex.venue]} ${signed(venueApr(cex) * 100, 0)}%)` : ""}`];
  const bp = Math.round(ctx.premium * 1e4);
  parts.push(bp === 0 ? "perp at spot" : `perp ${Math.abs(bp)} bp ${bp > 0 ? "over" : "under"} spot`);
  parts.push(`OI ${usdShort(ctx.openInterest * ctx.markPx)}${rank != null ? `, #${rank} on HL` : ""}`);
  if (atCap) parts.push("at OI cap");
  return parts.join(" · ");
}
