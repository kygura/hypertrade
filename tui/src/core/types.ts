// Shared contract between the TUI's core, commands, agent and UI layers.
// Core modules produce these shapes; the UI and the agent only read them.
import type { OrderIntent } from "../../../src/shared/intel.js";
import type { Verdict } from "../../../src/server/desk/types.js";
import type { FundingPoint } from "../../../src/shared/hl-client.js";
import type { Candle } from "../../../src/shared/types.js";

export type { Candle, FundingPoint, OrderIntent, Verdict };

export type Network = "testnet" | "mainnet";

export interface GovernorEnvLimits {
  maxRiskPct: number;
  maxOpenRiskPct: number;
  maxGrossLeverage: number;
  maxCoinLeverage: number;
  maxPositions: number;
  minRewardRisk: number;
}

export interface Config {
  network: Network;
  /** Account whose state is read. Null: no account configured (markets only). */
  account: string | null;
  /** True when an agent key is present and valid. The key itself never leaves config.ts/exchange.ts. */
  canTrade: boolean;
  maxNotionalUsd: number;
  /** Fraction, e.g. 0.01 for 1%. */
  slippage: number;
  watch: string[];
  limits: GovernorEnvLimits;
  defaultLeverage: number;
  lab: { url: string; token: string } | null;
  demo: boolean;
}

export interface MarketRow {
  coin: string;
  /** Index into meta.universe; the asset id used in exchange actions. */
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
  /** Latest WS mid when newer than the poll, else null. */
  midPx: number | null;
  prevDayPx: number;
  /** Percent, e.g. 2.5 for +2.5%. */
  dayChangePct: number;
  fundingHourly: number;
  /** Percent APR: hourly × 24 × 365 × 100. */
  fundingAprPct: number;
  /** Hyperliquid's predicted next hourly rate, when known. */
  predictedFundingHourly: number | null;
  oiUsd: number;
  dayVolumeUsd: number;
  premium: number | null;
  isDelisted: boolean;
  atOiCap: boolean;
}

export type Side = "long" | "short";

export interface PositionRow {
  coin: string;
  side: Side;
  /** Absolute size in coins. */
  size: number;
  entryPx: number;
  markPx: number;
  unrealizedPnlUsd: number;
  notionalUsd: number;
  leverage: number;
  liqPx: number | null;
  marginUsedUsd: number;
  /** From the reduce-only stop trigger order on this coin, if any. */
  stopPx: number | null;
  tpPx: number | null;
  /** Signed percent from mark to stop / liq (negative = adverse direction). */
  stopDistPct: number | null;
  liqDistPct: number | null;
}

export interface OpenOrder {
  oid: number;
  coin: string;
  side: "buy" | "sell";
  size: number;
  limitPx: number;
  triggerPx: number | null;
  isTrigger: boolean;
  reduceOnly: boolean;
  /** "sl" | "tp" for trigger orders, else null. */
  tpsl: "sl" | "tp" | null;
  orderType: string;
  timestamp: number;
}

export interface AccountSnapshot {
  address: string;
  equityUsd: number;
  marginUsedUsd: number;
  withdrawableUsd: number;
  unrealizedPnlUsd: number;
  positions: PositionRow[];
  orders: OpenOrder[];
  at: number;
}

export interface Level {
  px: number;
  sz: number;
}

export interface BookView {
  coin: string;
  bids: Level[];
  asks: Level[];
  mid: number | null;
  spreadBps: number | null;
  /** USD resting within 50 bps of mid on each side. */
  depth50Usd: { bid: number; ask: number };
  /** Slippage in bps vs mid to fill each size; null when the book is too thin. */
  slippage: Array<{ sizeUsd: number; buyBps: number | null; sellBps: number | null }>;
  at: number;
}

export interface CoinView {
  market: MarketRow;
  /** ATR14 on daily candles, price units. */
  atr14: number | null;
  regime: string | null;
  /** Free-form diagnostic lines from desk/analytics (trap components, rally reads). */
  diagnostics: string[];
  position: PositionRow | null;
}

export type AlertLevel = "info" | "warn" | "critical";

export interface Alert {
  key: string;
  level: AlertLevel;
  title: string;
  detail: string;
  at: number;
}

/**
 * Read side of Hyperliquid's /info endpoint for one network. Implemented by
 * core/info.ts (live) and core/demo.ts (fixtures). Tickets, the store and the
 * agent tools only ever read through this.
 */
export interface InfoSource {
  markets(): Promise<MarketRow[]>;
  account(address: string, markets: MarketRow[]): Promise<AccountSnapshot>;
  book(coin: string): Promise<BookView>;
  candles(coin: string, interval: "1h" | "4h" | "1d", startMs: number): Promise<Candle[]>;
  fundingHistory(coin: string, startMs: number): Promise<FundingPoint[]>;
}

export type WsState = "connecting" | "open" | "closed" | "off";

/** Everything the status bar and live views read. Owned by core/store.ts. */
export interface AppState {
  config: Config;
  markets: MarketRow[];
  marketsAt: number | null;
  account: AccountSnapshot | null;
  accountError: string | null;
  alerts: Alert[];
  ws: WsState;
}

// ─── Tickets ───

export type TicketAction =
  | { kind: "open"; intent: OrderIntent }
  | { kind: "close"; coin: string; pct: number }
  | { kind: "cancel"; oids: Array<{ coin: string; oid: number }> }
  | { kind: "stop"; coin: string; px: number };

export interface Ticket {
  id: string;
  action: TicketAction;
  network: Network;
  coin: string;
  side: Side | null;
  size: number | null;
  notionalUsd: number | null;
  entryPx: number | null;
  stopPx: number | null;
  tpPx: number | null;
  liqPx: number | null;
  riskUsd: number | null;
  riskPct: number | null;
  rr: number | null;
  leverage: number | null;
  slippageBps: number | null;
  /** Governor verdict for opens; null for close/cancel/stop. */
  verdict: Verdict | null;
  /** Hard stops that make canSend false (cap exceeded, read-only, governor reject…). */
  blockers: string[];
  warnings: string[];
  notes: string[];
  canSend: boolean;
  markPx: number | null;
  quotedAt: number;
}

export interface SendResult {
  ok: boolean;
  /** Human-readable lines for the transcript ("filled 0.012 BTC @ 61,234.5", "stop oid 123 resting"). */
  lines: string[];
  errors: string[];
  oids: number[];
}

/** Outcome of re-quoting a ticket at confirm time. */
export type Requote = { kind: "same"; ticket: Ticket } | { kind: "changed"; ticket: Ticket; why: string };
