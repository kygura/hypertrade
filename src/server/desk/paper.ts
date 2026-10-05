import type { MarketRef } from "./governor.js";
import type { Sizing, TradeProposal, AccountState, Position, Side } from "./types.js";
import type { DeskStore, PaperFill, PaperPosition } from "./store.js";

// The paper broker: fills at the live mark plus slippage and the taker fee,
// keeps one net position per coin with its stop and target, and settles
// stops/targets on each watch tick against the bar's high/low (so a wick
// through the stop between ticks still stops out). It is the desk's only
// executing venue for now; a live venue implements the same Broker shape.

export interface ExecutionResult {
  ok: boolean;
  venue: string;
  fills: Array<{ side: "buy" | "sell"; size: number; px: number; fee: number; pnl: number }>;
  note?: string;
  error?: string;
}

export interface Broker {
  readonly venue: string;
  /** True when orders reach a real exchange (testnet included). */
  readonly live: boolean;
  /** The venue's own market, when its marks differ from the analysis data (testnet). */
  market?(coin: string): Promise<MarketRef | null>;
  account(marks: Map<string, number>, now: Date): Promise<AccountState>;
  open(p: TradeProposal, sizing: Sizing, proposalId: string, now: Date): Promise<ExecutionResult>;
  exit(coin: string, size: number, markPx: number, reason: string, proposalId: string | null, now: Date): Promise<ExecutionResult>;
  /** Paper only: settle stops/targets locally (a live venue holds them on the exchange). */
  settle?(ranges: Map<string, { low: number; high: number }>, now: Date): Promise<Array<{ coin: string; kind: "stop" | "target"; result: ExecutionResult }>>;
  /** Paper only. */
  reset?(): Promise<void>;
}

interface PaperBook {
  /** Cash: starting equity plus realized PnL net of fees. */
  balance: number;
  /** Equity at the first look of each UTC day; the daily loss limit measures from here. */
  dayAnchor?: { date: string; equity: number };
}

export const PAPER_STATE_KEY = "paper_book";

export function unrealized(p: Pick<PaperPosition, "side" | "size" | "entryPx">, mark: number): number {
  return (p.side === "long" ? mark - p.entryPx : p.entryPx - mark) * p.size;
}

/** Stop or target touched by a bar's range; the stop wins when both are inside one bar. */
export function protectiveHit(p: Pick<PaperPosition, "side" | "stopPx" | "tpPx">, low: number, high: number): { kind: "stop" | "target"; px: number } | null {
  const long = p.side === "long";
  if (long ? low <= p.stopPx : high >= p.stopPx) return { kind: "stop", px: p.stopPx };
  if (p.tpPx != null && (long ? high >= p.tpPx : low <= p.tpPx)) return { kind: "target", px: p.tpPx };
  return null;
}

export class PaperBroker implements Broker {
  readonly venue = "paper";
  readonly live = false;
  constructor(
    private readonly store: DeskStore,
    private readonly opts: { startingEquity: number; slippage: number; takerFee: number },
  ) {}

  private async book(): Promise<PaperBook> {
    return (await this.store.getState<PaperBook>(PAPER_STATE_KEY)) ?? { balance: this.opts.startingEquity };
  }

  async account(marks: Map<string, number>, now: Date): Promise<AccountState> {
    const book = await this.book();
    const rows = await this.store.paperPositions();
    const positions: Position[] = rows.map((r) => {
      const mark = marks.get(r.coin) ?? r.entryPx;
      return {
        coin: r.coin,
        side: r.side,
        size: r.size,
        entryPx: r.entryPx,
        markPx: mark,
        stopPx: r.stopPx,
        tpPx: r.tpPx,
        unrealizedPnl: unrealized(r, mark),
        notionalUsd: r.size * mark,
      };
    });
    const equity = book.balance + positions.reduce((a, p) => a + p.unrealizedPnl, 0);
    const date = now.toISOString().slice(0, 10);
    if (book.dayAnchor?.date !== date) {
      book.dayAnchor = { date, equity };
      await this.store.setState(PAPER_STATE_KEY, book);
    }
    return { venue: this.venue, equityUsd: equity, dayPnlUsd: equity - book.dayAnchor.equity, positions, available: true };
  }

  async open(p: TradeProposal, sizing: Sizing, proposalId: string, now: Date): Promise<ExecutionResult> {
    const existing = (await this.store.paperPositions()).find((x) => x.coin === p.coin);
    if (existing) return { ok: false, venue: this.venue, fills: [], error: `already holding ${p.coin}` };
    const side: "buy" | "sell" = p.side === "long" ? "buy" : "sell";
    const px = sizing.markPx * (1 + (side === "buy" ? 1 : -1) * this.opts.slippage);
    const fee = sizing.size * px * this.opts.takerFee;
    const book = await this.book();
    book.balance -= fee;
    await this.store.setState(PAPER_STATE_KEY, book);
    await this.store.savePaperPosition({
      coin: p.coin,
      side: p.side,
      size: sizing.size,
      entryPx: px,
      stopPx: p.stop,
      tpPx: p.target,
      proposalId,
      openedAt: now.toISOString(),
    });
    const fill: PaperFill = { ts: now.toISOString(), coin: p.coin, side, size: sizing.size, px, fee, pnl: 0, reason: "entry", proposalId };
    await this.store.insertFill(fill);
    return { ok: true, venue: this.venue, fills: [{ side, size: sizing.size, px, fee, pnl: 0 }] };
  }

  /** Closes `size` of the coin at `markPx` (slipped), or at exactly `markPx` for a stop/target fill. */
  async exit(coin: string, size: number, markPx: number, reason: string, proposalId: string | null, now: Date, exact = false): Promise<ExecutionResult> {
    const pos = (await this.store.paperPositions()).find((x) => x.coin === coin);
    if (!pos) return { ok: false, venue: this.venue, fills: [], error: `no ${coin} position` };
    const qty = Math.min(size, pos.size);
    const side: "buy" | "sell" = pos.side === "long" ? "sell" : "buy";
    const px = exact ? markPx : markPx * (1 + (side === "buy" ? 1 : -1) * this.opts.slippage);
    const fee = qty * px * this.opts.takerFee;
    const pnl = unrealized({ side: pos.side, size: qty, entryPx: pos.entryPx }, px);
    const book = await this.book();
    book.balance += pnl - fee;
    await this.store.setState(PAPER_STATE_KEY, book);
    const rest = pos.size - qty;
    if (rest <= pos.size * 1e-9) await this.store.deletePaperPosition(coin);
    else await this.store.savePaperPosition({ ...pos, size: rest });
    await this.store.insertFill({ ts: now.toISOString(), coin, side, size: qty, px, fee, pnl, reason, proposalId });
    return { ok: true, venue: this.venue, fills: [{ side, size: qty, px, fee, pnl }] };
  }

  /** Settles stops/targets for every position against each coin's range since the last tick. */
  async settle(ranges: Map<string, { low: number; high: number }>, now: Date): Promise<Array<{ coin: string; kind: "stop" | "target"; result: ExecutionResult }>> {
    const out: Array<{ coin: string; kind: "stop" | "target"; result: ExecutionResult }> = [];
    for (const pos of await this.store.paperPositions()) {
      const range = ranges.get(pos.coin);
      if (!range) continue;
      const hit = protectiveHit(pos, range.low, range.high);
      if (!hit) continue;
      const result = await this.exit(pos.coin, pos.size, hit.px, hit.kind, pos.proposalId, now, true);
      out.push({ coin: pos.coin, kind: hit.kind, result });
    }
    return out;
  }

  async reset(): Promise<void> {
    for (const p of await this.store.paperPositions()) await this.store.deletePaperPosition(p.coin);
    await this.store.setState(PAPER_STATE_KEY, { balance: this.opts.startingEquity });
  }
}

export const sideToOrder = (s: Side): "buy" | "sell" => (s === "long" ? "buy" : "sell");
