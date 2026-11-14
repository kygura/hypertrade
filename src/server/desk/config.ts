import { addressOf, isPrivateKey } from "./hl/signing.js";
import { proprBaseUrl } from "./propr/client.js";
import type { Confidence } from "./types.js";

// Desk settings from the environment (docs/SPEC.md "Desk", .env.example). Every
// limit has a conservative default so an unconfigured deployment trades
// paper only, with small risk, and always behind the governor.

export type Approval = "manual" | "auto";
export type Venue = "paper" | "hl-testnet" | "propr";

export interface HlVenueConfig {
  /** API (agent) wallet private key. Server-side only; never serialized. */
  secretKey: string;
  /** Master account the agent wallet trades for. */
  account: string;
  leverage: number;
  slippage: number;
}

/** Propr challenge or funded account (Hyperliquid mainnet through Propr's API). Ported from perp-radar's executor. */
export interface ProprVenueConfig {
  /** PROPR_API_KEY. Server-side only; never serialized. */
  apiKey: string;
  accountId: string;
  baseUrl: string;
  /** Orders are sent only when PROPR_LIVE=true; otherwise every entry and exit is a dry run that builds the requests. */
  live: boolean;
  /** PROPR_STARTING_BALANCE: used when the account does not report its own starting balance. */
  startingBalance?: number;
  /** Cross leverage ceiling set before a ladder (the governor's leverage caps sit under it). */
  maxLeverage: number;
  ladder: {
    /** Rungs from the mark toward the stop (1 = a single entry). */
    rungs: number;
    rungsByCoin: Record<string, number>;
    /** First rung fills at market; the rest rest as limits. */
    firstAtMarket: boolean;
    /** Last rung keeps at least this share of the entry-to-stop distance before the stop. */
    minStopGapShare: number;
    /** Smallest rung in dollars (Hyperliquid's minimum is about $10). */
    minRungUsd: number;
    /** Unfilled rungs are cancelled by the watch tick after this many hours. */
    ttlHours: number;
  };
  firm: {
    maxEntriesPerDay: number;
    /** Propr 1-Step: 3% daily from the 00:00 UTC balance and a 6% static floor, both on equity. */
    dailyLossPct: number;
    maxDrawdownPct: number;
    /** The worst case assumes the stop fills this many times its distance away. */
    stopSlipFactor: number;
    /** Fee per side, percent (Propr quotes 0.075%). */
    feePct: number;
    /** Equity kept above the daily-loss floor after the worst case, % of the day-start balance. */
    dailyBufferPct: number;
    /** Equity kept above the static drawdown floor after the worst case, % of the starting balance. */
    floorBufferPct: number;
    /** No new entries for the rest of the UTC day once this share of the daily limit is used. */
    haltDailyUsedShare: number;
  };
}

export interface GovernorLimits {
  /** Max percent of equity at risk on one new trade. */
  maxRiskPct: number;
  /** Max sum of open stop risk, percent of equity, including the new trade. */
  maxOpenRiskPct: number;
  /** Max gross notional / equity after the trade. */
  maxGrossLeverage: number;
  /** Max one coin's notional / equity. */
  maxCoinLeverage: number;
  maxPositions: number;
  minRewardRisk: number;
  minStopPct: number;
  maxStopPct: number;
  /** Day loss (percent of equity) that blocks new entries until 00:00 UTC. */
  dailyLossLimitPct: number;
  minConfidence: Confidence;
  minNotionalUsd: number;
  /** Taker fee per side, fraction (HL base tier 0.045%). */
  takerFee: number;
}

export interface DeskConfig {
  venue: Venue;
  /** Set when venue is hl-testnet. */
  hl?: HlVenueConfig;
  /** Set when venue is propr. */
  propr?: ProprVenueConfig;
  /** Why the requested venue was not used, if it was not. */
  venueNote?: string;
  approval: Approval;
  limits: GovernorLimits;
  paperStartingEquity: number;
  /** Paper fills cross this much slippage, fraction. */
  paperSlippage: number;
  /** Hyperliquid account to watch read-only (positions, equity); never signs. */
  watchAddress?: string;
  /** DESK_WATCHLIST: the monitoring fallback when the UI watchlist (intel_watchlist) is empty; DeskService.watchlist() resolves the list in force. */
  watchlist: string[];
  /** Scout model/provider overrides; default: the analyst's server default. */
  scoutModel?: string;
  scoutProvider?: string;
  /** Upper bound on autonomous cycles per UTC day (LLM cost guard). */
  maxCyclesPerDay: number;
  /** Minimum minutes between two trigger-fired cycles. */
  cycleCooldownMin: number;
  /** Hours between scheduled full reviews (0 disables them). */
  reviewEveryHours: number;
  /** Pending proposals expire after this many minutes. */
  approvalTtlMin: number;
  /** hl-cycles static export base URL (on-chain/cycle regime), optional. */
  cyclesUrl?: string;
  /** Public origin of this app, for links in alerts. */
  appUrl?: string;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function list(v: string | undefined, def: string[]): string[] {
  const items = (v ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return items.length ? items : def;
}

export function loadDeskConfig(env: Env = process.env): DeskConfig {
  const conf = env.DESK_MIN_CONFIDENCE?.trim().toLowerCase();
  const address = env.DESK_WATCH_ADDRESS?.trim();
  const venue = resolveVenue(env);
  return {
    ...venue,
    approval: env.DESK_APPROVAL?.trim().toLowerCase() === "manual" ? "manual" : "auto",
    limits: {
      maxRiskPct: num(env, "DESK_MAX_RISK_PCT", 0.5, 0.05, 2),
      maxOpenRiskPct: num(env, "DESK_MAX_OPEN_RISK_PCT", 2, 0.1, 10),
      maxGrossLeverage: num(env, "DESK_MAX_GROSS_LEVERAGE", 2, 0.1, 10),
      maxCoinLeverage: num(env, "DESK_MAX_COIN_LEVERAGE", 1, 0.05, 5),
      maxPositions: num(env, "DESK_MAX_POSITIONS", 4, 1, 20),
      minRewardRisk: num(env, "DESK_MIN_RR", 1.5, 0.5, 10),
      minStopPct: num(env, "DESK_MIN_STOP_PCT", 0.5, 0.05, 10),
      maxStopPct: num(env, "DESK_MAX_STOP_PCT", 15, 1, 50),
      dailyLossLimitPct: num(env, "DESK_DAILY_LOSS_PCT", 2, 0.1, 20),
      minConfidence: conf === "low" || conf === "high" ? conf : "medium",
      minNotionalUsd: 10,
      takerFee: 0.00045,
    },
    paperStartingEquity: num(env, "DESK_PAPER_EQUITY", 10_000, 100, 1e9),
    paperSlippage: 0.0005,
    watchAddress: address && /^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : undefined,
    // Fallback monitoring list: the WATCH page (intel_watchlist) is canonical for desk pings and the Intel brief, and this
    // applies only while it is empty (intel/positions.ts watchedAssets). Kept narrow because each coin can alert; not myMarkets.
    watchlist: list(env.DESK_WATCHLIST, ["BTC", "ETH", "SOL", "HYPE"]),
    scoutModel: env.DESK_SCOUT_MODEL?.trim() || undefined,
    scoutProvider: env.DESK_SCOUT_PROVIDER?.trim() || undefined,
    maxCyclesPerDay: num(env, "DESK_MAX_CYCLES_PER_DAY", 8, 0, 96),
    cycleCooldownMin: num(env, "DESK_CYCLE_COOLDOWN_MIN", 60, 5, 1440),
    reviewEveryHours: num(env, "DESK_REVIEW_HOURS", 8, 0, 168),
    approvalTtlMin: num(env, "DESK_APPROVAL_TTL_MIN", 120, 5, 10_080),
    cyclesUrl: env.DESK_CYCLES_URL?.trim().replace(/\/+$/, "") || undefined,
    appUrl: (env.APP_URL ?? env.DESK_APP_URL)?.trim().replace(/\/+$/, "") || undefined,
  };
}

/**
 * DESK_VENUE: "paper" (default), "hl-testnet" or "propr". Hyperliquid mainnet
 * is refused; Propr is reached only through its own API and sends nothing
 * unless PROPR_LIVE=true. A bad or missing key falls back to paper with a note
 * the status endpoint shows, so a typo never leaves the desk half-live.
 */
function resolveVenue(env: Env): Pick<DeskConfig, "venue" | "hl" | "propr" | "venueNote"> {
  const want = env.DESK_VENUE?.trim().toLowerCase() || "paper";
  if (want === "paper") return { venue: "paper" };
  if (want === "propr") return resolvePropr(env);
  if (want !== "hl-testnet") {
    return { venue: "paper", venueNote: `DESK_VENUE=${want} is not supported (paper, hl-testnet or propr); trading paper` };
  }
  const key = env.DESK_HL_SECRET_KEY?.trim();
  if (!isPrivateKey(key)) return { venue: "paper", venueNote: "DESK_VENUE=hl-testnet needs DESK_HL_SECRET_KEY (an API wallet key); trading paper" };
  const acct = env.DESK_HL_ACCOUNT?.trim();
  if (acct && !/^0x[0-9a-fA-F]{40}$/.test(acct)) return { venue: "paper", venueNote: "DESK_HL_ACCOUNT is not an address; trading paper" };
  return {
    venue: "hl-testnet",
    hl: {
      secretKey: key.startsWith("0x") ? key : `0x${key}`,
      account: (acct ?? addressOf(key)).toLowerCase(),
      leverage: num(env, "DESK_HL_LEVERAGE", 3, 1, 20),
      slippage: num(env, "DESK_HL_SLIPPAGE_PCT", 1, 0.1, 5) / 100,
    },
  };
}

const clampInt = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(x)));

/** "BTC:8, sol:3" to { BTC: 8, SOL: 3 }, each clamped; bad pairs are dropped. */
function byCoin(v: string | undefined, lo: number, hi: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (v ?? "").split(/[,;\s]+/)) {
    const m = /^([A-Za-z0-9]+)[:=]([0-9.]+)$/.exec(part.trim());
    if (m && Number.isFinite(Number(m[2]))) out[m[1]!.toUpperCase()] = clampInt(Number(m[2]), lo, hi);
  }
  return out;
}

function resolvePropr(env: Env): Pick<DeskConfig, "venue" | "propr" | "venueNote"> {
  const flag = env.PROPR_KILL?.trim().toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") return { venue: "paper", venueNote: "PROPR_KILL is set; trading paper" };
  const apiKey = env.PROPR_API_KEY?.trim();
  if (!apiKey) return { venue: "paper", venueNote: "DESK_VENUE=propr needs PROPR_API_KEY; trading paper" };
  const accountId = env.PROPR_ACCOUNT_ID?.trim();
  if (!accountId) return { venue: "paper", venueNote: "DESK_VENUE=propr needs PROPR_ACCOUNT_ID (the challenge or funded account); trading paper" };
  let baseUrl: string;
  try {
    baseUrl = proprBaseUrl(env.PROPR_API_URL);
  } catch (e) {
    return { venue: "paper", venueNote: `${e instanceof Error ? e.message : String(e)}; trading paper` };
  }
  const start = Number(env.PROPR_STARTING_BALANCE?.trim() || NaN);
  const mkt = env.PROPR_LADDER_FIRST_AT_MARKET?.trim().toLowerCase();
  return {
    venue: "propr",
    propr: {
      apiKey,
      accountId,
      baseUrl,
      live: env.PROPR_LIVE?.trim() === "true",
      startingBalance: Number.isFinite(start) && start > 0 ? start : undefined,
      maxLeverage: num(env, "PROPR_MAX_LEVERAGE", 3, 1, 10),
      ladder: {
        rungs: clampInt(num(env, "PROPR_LADDER_RUNGS", 5, 1, 20), 1, 20),
        rungsByCoin: byCoin(env.PROPR_LADDER_RUNGS_BY_COIN, 1, 20),
        firstAtMarket: !(mkt === "false" || mkt === "0" || mkt === "no"),
        minStopGapShare: 0.2,
        minRungUsd: 11,
        ttlHours: num(env, "PROPR_LADDER_TTL_HOURS", 8, 1, 24),
      },
      firm: {
        maxEntriesPerDay: clampInt(num(env, "PROPR_MAX_ENTRIES_PER_DAY", 2, 0, 3), 0, 3),
        dailyLossPct: num(env, "PROPR_DAILY_LOSS_PCT", 3, 1, 5),
        maxDrawdownPct: num(env, "PROPR_MAX_DRAWDOWN_PCT", 6, 1, 10),
        stopSlipFactor: 1.5,
        feePct: 0.075,
        dailyBufferPct: 1,
        floorBufferPct: 1.5,
        haltDailyUsedShare: 0.5,
      },
    },
  };
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
export const confidenceAtLeast = (c: Confidence, min: Confidence) => CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[min];
