import type { Confidence } from "./types.js";

// Desk settings from the environment (SPEC.md "Desk", .env.example). Every
// limit has a conservative default so an unconfigured deployment trades
// paper only, with small risk, and always behind the governor.

export type Approval = "manual" | "auto";
export type Venue = "paper";

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
  approval: Approval;
  limits: GovernorLimits;
  paperStartingEquity: number;
  /** Paper fills cross this much slippage, fraction. */
  paperSlippage: number;
  /** Hyperliquid account to watch read-only (positions, equity); never signs. */
  watchAddress?: string;
  /** Coins the watch tick always checks, beyond held positions. */
  watchlist: string[];
  /** Agent model overrides; default: the analyst's server default. */
  orchestratorModel?: string;
  specialistModel?: string;
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
  return {
    venue: "paper",
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
    orchestratorModel: env.DESK_MODEL?.trim() || undefined,
    specialistModel: env.DESK_SPECIALIST_MODEL?.trim() || undefined,
    maxCyclesPerDay: num(env, "DESK_MAX_CYCLES_PER_DAY", 8, 0, 96),
    cycleCooldownMin: num(env, "DESK_CYCLE_COOLDOWN_MIN", 60, 5, 1440),
    reviewEveryHours: num(env, "DESK_REVIEW_HOURS", 8, 0, 168),
    approvalTtlMin: num(env, "DESK_APPROVAL_TTL_MIN", 120, 5, 10_080),
    cyclesUrl: env.DESK_CYCLES_URL?.trim().replace(/\/+$/, "") || undefined,
    appUrl: (env.APP_URL ?? env.DESK_APP_URL)?.trim().replace(/\/+$/, "") || undefined,
  };
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
export const confidenceAtLeast = (c: Confidence, min: Confidence) => CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[min];
