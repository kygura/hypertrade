import { addressOf, isPrivateKey } from "./hl/signing.js";
import type { Confidence } from "./types.js";

// Desk settings from the environment (SPEC.md "Desk", .env.example). Every
// limit has a conservative default so an unconfigured deployment trades
// paper only, with small risk, and always behind the governor.

export type Approval = "manual" | "auto";
export type Venue = "paper" | "hl-testnet";

export interface HlVenueConfig {
  /** API (agent) wallet private key. Server-side only; never serialized. */
  secretKey: string;
  /** Master account the agent wallet trades for. */
  account: string;
  leverage: number;
  slippage: number;
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
  /** Why the requested venue was not used, if it was not. */
  venueNote?: string;
  approval: Approval;
  limits: GovernorLimits;
  paperStartingEquity: number;
  /** Paper fills cross this much slippage, fraction. */
  paperSlippage: number;
  /** Hyperliquid account to watch read-only (positions, equity); never signs. */
  watchAddress?: string;
  /** Coins the watch tick always checks, beyond held positions. */
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
 * DESK_VENUE: "paper" (default) or "hl-testnet". Mainnet is refused on
 * purpose; a bad or missing key falls back to paper with a note the status
 * endpoint shows, so a typo never leaves the desk half-live.
 */
function resolveVenue(env: Env): Pick<DeskConfig, "venue" | "hl" | "venueNote"> {
  const want = env.DESK_VENUE?.trim().toLowerCase() || "paper";
  if (want === "paper") return { venue: "paper" };
  if (want !== "hl-testnet") {
    return { venue: "paper", venueNote: `DESK_VENUE=${want} is not supported (paper or hl-testnet); trading paper` };
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

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
export const confidenceAtLeast = (c: Confidence, min: Confidence) => CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[min];
