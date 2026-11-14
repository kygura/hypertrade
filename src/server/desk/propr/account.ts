import type { AccountState, Position } from "../types.js";
import type { ProprClient, Row } from "./client.js";
import { isLadderId } from "./ids.js";

// Reading a Propr account into what the desk and the firm guards need. Pure parsers over Propr's raw rows, plus one
// read that fetches them. Ported from perp-radar's executor (readAccount, readPositions, pendingLadderRisk,
// countEntriesToday, estimateDayStart).

export interface ProprPosition {
  coin: string;
  side: "long" | "short";
  qty: number;
  entry: number;
  mark: number;
  /** Farthest protective stop when stops cover the whole position, else null (the position counts as unprotected). */
  stop: number | null;
  tp: number | null;
}

export interface ProprSnapshot {
  accountId: string;
  /** Balance the challenge or funded account started at; the static drawdown floor hangs off it. */
  startingBalance: number;
  balance: number;
  /** Balance plus unrealized P&L: what Propr checks both loss limits against. */
  equity: number;
  /** Balance at 00:00 UTC, never lower than the real one (see estimateDayStart). */
  dayStartBalance: number;
  positions: ProprPosition[];
  /** Entries since 00:00 UTC, manual ones included; a whole ladder counts once. */
  entriesToday: number;
  /** What the unfilled rungs of the desk's ladders would lose if they all filled and stopped out (Infinity when one has no stop). */
  pendingRisk: number;
  /** Coins with an entry order still resting. */
  working: string[];
  orders: Row[];
}

const num = (x: unknown): number | null => {
  const v = typeof x === "string" ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isFinite(v) ? v : null;
};
const firstNum = (o: Row | undefined, keys: string[]) => {
  for (const k of keys) {
    const v = num(o?.[k]);
    if (v != null) return v;
  }
  return null;
};
export const utcMidnight = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const OPEN = ["open", "pending", "partially_filled"];
export const isEntry = (o: Row) => (o.type === "market" || o.type === "limit") && o.reduceOnly !== true;
export const isOpen = (o: Row) => OPEN.includes(String(o.status));

/** Propr publishes no start-of-day balance in its API docs. Use the field if the account carries one, otherwise rebuild
 * it from today's realized P&L and fees. Take the highest candidate: a higher anchor means a higher floor, less room. */
export function estimateDayStart(balance: number, acct: Row, trades: Row[], now: number): number {
  const field = firstNum(acct, ["startOfDayBalance", "dayStartBalance", "dailyStartBalance", "dailyBalance", "sodBalance"]);
  const since = utcMidnight(now);
  let realizedToday = 0;
  for (const t of trades) {
    const at = Date.parse(String(t.executedAt ?? t.createdAt ?? ""));
    if (!(at >= since)) continue;
    realizedToday += (num(t.realizedPnl) ?? 0) - (num(t.fee) ?? 0);
  }
  return Math.max(balance, balance - realizedToday, field ?? 0);
}

export function readPositions(rawPos: Row[], rawOrders: Row[]): ProprPosition[] {
  const reduce = rawOrders.filter((o) => o.reduceOnly === true && isOpen(o));
  return rawPos
    .filter((p) => (num(p.quantity) ?? 0) !== 0 && p.status !== "closed")
    .map((p) => {
      const qty = Math.abs(num(p.quantity) ?? 0);
      const side = p.positionSide === "short" ? "short" : "long";
      const coin = String(p.base || p.asset || "?");
      const mine = reduce.filter((o) => (o.positionId && o.positionId === p.positionId) || (o.base === coin && o.positionSide === side));
      const stops = mine.filter((o) => o.type === "stop_market" || o.type === "stop_limit");
      const covered = stops.reduce((s, o) => s + Math.abs(num(o.quantity) ?? 0), 0);
      // Ladder rungs each carry a stop for their own quantity, so together they cover the merged position.
      const triggers = stops.map((o) => num(o.triggerPrice)).filter((x): x is number => x != null);
      const stop = covered >= qty * 0.99 && triggers.length ? (side === "long" ? Math.min(...triggers) : Math.max(...triggers)) : null;
      const tps = mine.filter((o) => o.type === "take_profit_market").map((o) => num(o.triggerPrice)).filter((x): x is number => x != null);
      const tp = tps.length ? (side === "long" ? Math.max(...tps) : Math.min(...tps)) : null;
      const entry = num(p.entryPrice) ?? 0;
      return { coin, side, qty, entry, mark: num(p.markPrice) ?? entry, stop, tp };
    });
}

/** Unfilled ladder rungs: what they'd lose at their own stop if they all filled. */
export function pendingLadderRisk(orders: Row[]): number {
  let total = 0;
  for (const e of orders.filter((o) => isEntry(o) && isOpen(o) && isLadderId(o.intentId))) {
    const stop = orders.find((o) => o.orderGroupId && o.orderGroupId === e.orderGroupId && o.type === "stop_market");
    const px = num(e.price);
    const trig = num(stop?.triggerPrice);
    const left = Math.abs(num(e.quantity) ?? 0) - Math.abs(num(e.cumulativeQuantity) ?? 0);
    if (px == null || trig == null) return Infinity;
    total += Math.max(0, left) * Math.abs(px - trig);
  }
  return total;
}

/** Entries today: each manual entry order counts once, each of the desk's ladders counts once. */
export function countEntriesToday(orders: Row[], now: number): number {
  const since = utcMidnight(now);
  const ladders = new Set<string>();
  let manual = 0;
  for (const o of orders) {
    if (!isEntry(o) || o.status === "rejected" || !(Date.parse(String(o.createdAt ?? "")) >= since)) continue;
    if (isLadderId(o.intentId)) ladders.add(`${String(o.intentId).slice(0, 10)}:${String(o.base)}`);
    else manual++;
  }
  return manual + ladders.size;
}

/** Builds the snapshot from raw rows. Throws when the account cannot be trusted (no balance, no starting balance). */
export function snapshotFrom(input: { accountId: string; attempt: Row; account: Row; positions: Row[]; orders: Row[]; trades: Row[]; startingBalanceEnv?: number; now: number }): ProprSnapshot {
  const { account: acct, attempt } = input;
  const balance = firstNum(acct, ["balance"]);
  if (balance == null) throw new Error("account balance missing from Propr's answer");
  const upnl = firstNum(acct, ["totalUnrealizedPnl"]) ?? 0;
  const iso = firstNum(acct, ["isolatedPositionMargin"]) ?? 0;
  const equity = Math.min(...[firstNum(acct, ["marginBalance", "equity"]), balance + upnl + iso].filter((x): x is number => x != null));
  const challenge = (attempt.challenge ?? {}) as Row;
  const detected = firstNum(attempt, ["initialBalance", "startingBalance", "accountSize"]) ?? firstNum(challenge, ["initialBalance", "startingBalance", "accountSize"]);
  if (detected == null && input.startingBalanceEnv == null) throw new Error("starting balance unknown: set PROPR_STARTING_BALANCE");
  return {
    accountId: input.accountId,
    startingBalance: Math.max(detected ?? 0, input.startingBalanceEnv ?? 0),
    balance,
    equity,
    dayStartBalance: estimateDayStart(balance, acct, input.trades, input.now),
    positions: readPositions(input.positions, input.orders),
    entriesToday: countEntriesToday(input.orders, input.now),
    pendingRisk: pendingLadderRisk(input.orders),
    working: [...new Set(input.orders.filter((o) => isEntry(o) && isOpen(o)).map((o) => String(o.base ?? o.asset)))],
    orders: input.orders,
  };
}

/** One read of the configured account; it must be an active challenge or funded account. */
export async function readSnapshot(client: ProprClient, accountId: string, startingBalanceEnv: number | undefined, now: number): Promise<ProprSnapshot> {
  const attempts = await client.activeAttempts();
  const attempt = attempts.find((a) => a.accountId === accountId);
  if (!attempt) throw new Error("PROPR_ACCOUNT_ID is not an active challenge or funded account");
  const [account, positions, orders, trades] = await Promise.all([client.account(accountId), client.positions(accountId), client.orders(accountId), client.trades(accountId)]);
  return snapshotFrom({ accountId, attempt, account, positions, orders, trades, startingBalanceEnv, now });
}

/** The desk's view of the account. Marks come from Hyperliquid mainnet, which is where Propr routes. */
export function toAccountState(s: ProprSnapshot, marks: Map<string, number>, venue: string, note?: string): AccountState {
  const positions: Position[] = s.positions.map((p) => {
    const mark = marks.get(p.coin) ?? p.mark;
    const unrealizedPnl = (p.side === "long" ? mark - p.entry : p.entry - mark) * p.qty;
    return { coin: p.coin, side: p.side, size: p.qty, entryPx: p.entry, markPx: mark, stopPx: p.stop, tpPx: p.tp, unrealizedPnl, notionalUsd: p.qty * mark };
  });
  return { venue, equityUsd: s.equity, dayPnlUsd: s.equity - s.dayStartBalance, positions, available: true, note };
}
