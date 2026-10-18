// Agent tools. Every tool is read-only except draft_order / draft_close, which
// hand a TicketAction to the host (deps.draftOrder), show the resulting ticket
// to the human, and return a preview to the model. Nothing here can send an
// order. Results are compact JSON; throwing is how a tool reports an error
// (the loop turns it into an isError result).
import { z } from "zod";
import { OrderIntentSchema, SideSchema, type OrderIntent } from "../../../src/shared/intel.js";
import type { ToolSpec } from "../../../src/server/llm/provider.js";
import { buildCoinView } from "../core/coin.js";
import { PulseSchema } from "../core/lab.js";
import type { AccountSnapshot, AppState, InfoSource, MarketRow, Ticket, TicketAction } from "../core/types.js";

export interface AgentDeps {
  getState(): AppState;
  info: InfoSource;
  oiSeries(coin: string): Array<{ t: number; v: number }>;
  /** Throws when the lab is not configured. */
  pulse(): Promise<unknown>;
  brief(): Promise<unknown | null>;
  /** The host builds the ticket, shows it to the human, and returns it. */
  draftOrder(action: TicketAction): Promise<Ticket>;
}

export interface AgentTool {
  spec: ToolSpec;
  run(input: unknown, signal: AbortSignal): Promise<string>;
}

export const NOT_SENT = "Ticket shown to the human for confirmation. It has NOT been sent. Do not claim it was sent.";

const HOUR = 3_600_000;
const MAX_CHARS = 16_000;

// ─── formatting ───

const sig = (n: number, digits = 6) => (Number.isFinite(n) ? Number(n.toPrecision(digits)) : null);
const usd = (n: number) => (Number.isFinite(n) ? Math.round(n) : null);
const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z";
const out = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}…[truncated, ${s.length} chars; ask for fewer rows]` : s;
};

function marketRow(m: MarketRow) {
  return {
    coin: m.coin,
    markPx: sig(m.markPx),
    chg24hPct: pct(m.dayChangePct),
    fundingAprPct: pct(m.fundingAprPct),
    oiUsd: usd(m.oiUsd),
    volume24hUsd: usd(m.dayVolumeUsd),
    ...(m.atOiCap ? { atOiCap: true } : {}),
  };
}

function accountOut(a: AccountSnapshot) {
  return {
    equityUsd: usd(a.equityUsd),
    marginUsedUsd: usd(a.marginUsedUsd),
    withdrawableUsd: usd(a.withdrawableUsd),
    unrealizedPnlUsd: usd(a.unrealizedPnlUsd),
    asOf: iso(a.at),
    positions: a.positions.map(positionOut),
    orders: a.orders.map((o) => ({
      oid: o.oid,
      coin: o.coin,
      side: o.side,
      size: sig(o.size),
      limitPx: sig(o.limitPx),
      triggerPx: o.triggerPx == null ? null : sig(o.triggerPx),
      tpsl: o.tpsl,
      reduceOnly: o.reduceOnly,
    })),
  };
}

function positionOut(p: AccountSnapshot["positions"][number]) {
  return {
    coin: p.coin,
    side: p.side,
    size: sig(p.size),
    entryPx: sig(p.entryPx),
    markPx: sig(p.markPx),
    uPnlUsd: usd(p.unrealizedPnlUsd),
    notionalUsd: usd(p.notionalUsd),
    leverage: p.leverage,
    liqPx: p.liqPx == null ? null : sig(p.liqPx),
    stopPx: p.stopPx == null ? null : sig(p.stopPx),
    tpPx: p.tpPx == null ? null : sig(p.tpPx),
    stopDistPct: pct(p.stopDistPct),
    liqDistPct: pct(p.liqDistPct),
  };
}

// ─── input handling ───

const FIELD_HINTS: Record<string, string> = {
  size: 'required, one of {"usd": number} or {"pctBook": number}; there is no default, ask the human',
  stop: 'required, e.g. {"type":"pct","pct":2}, {"type":"price","px":60000}, {"type":"atr_mult","mult":1.5}, {"type":"prev_day_low"}',
};

function zodMessage(tool: string, err: z.ZodError, input?: unknown): string {
  const given = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const parts = err.issues.slice(0, 4).map((i) => {
    const path = i.path.join(".") || "input";
    const hint = i.path.length === 1 && given[String(i.path[0])] === undefined ? FIELD_HINTS[String(i.path[0])] : undefined;
    return `${path}: ${hint ?? i.message}`;
  });
  return `invalid input to ${tool}: ${parts.join("; ")}`;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

/** The listed market for `input` (case-insensitive), or an error that names the closest coins. */
function findMarket(state: AppState, input: string): MarketRow {
  const q = input.trim().toUpperCase();
  const live = state.markets.filter((m) => !m.isDelisted);
  const hit = live.find((m) => m.coin.toUpperCase() === q);
  if (hit) return hit;
  if (!live.length) throw new Error(`unknown coin ${input}: no markets loaded yet${state.marketsError ? ` (${state.marketsError})` : ""}`);
  const near = live
    .map((m) => {
      const c = m.coin.toUpperCase();
      const score = c.startsWith(q) || q.startsWith(c) ? 0 : c.includes(q) || q.includes(c) ? 1 : editDistance(c, q) <= 2 ? 2 : 9;
      return { coin: m.coin, score, oi: m.oiUsd };
    })
    .filter((x) => x.score < 9)
    .sort((a, b) => a.score - b.score || b.oi - a.oi)
    .slice(0, 5)
    .map((x) => x.coin);
  throw new Error(`unknown coin ${input}${near.length ? `; close matches: ${near.join(", ")}` : "; not in the Hyperliquid universe (use get_markets to list)"}`);
}

function def<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  schema: S,
  handler: (input: z.infer<S>, signal: AbortSignal) => Promise<string> | string,
): AgentTool {
  return {
    spec: { name, description, input_schema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false } },
    async run(input, signal) {
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) throw new Error(zodMessage(name, parsed.error, input));
      return handler(parsed.data, signal);
    },
  };
}

const CoinOnly = z.object({ coin: z.string().trim().min(1) });
const coinProp = { coin: { type: "string", description: "Hyperliquid coin symbol, e.g. BTC, ETH, SOL, HYPE" } };

const SORTS = ["oi", "volume", "change_up", "change_down", "funding_high", "funding_low"] as const;
const sorters: Record<(typeof SORTS)[number], (a: MarketRow, b: MarketRow) => number> = {
  oi: (a, b) => b.oiUsd - a.oiUsd,
  volume: (a, b) => b.dayVolumeUsd - a.dayVolumeUsd,
  change_up: (a, b) => b.dayChangePct - a.dayChangePct,
  change_down: (a, b) => a.dayChangePct - b.dayChangePct,
  funding_high: (a, b) => b.fundingAprPct - a.fundingAprPct,
  funding_low: (a, b) => a.fundingAprPct - b.fundingAprPct,
};

const StopInput = OrderIntentSchema.shape.stop;
const DraftOrderInput = z.object({
  coin: z.string().trim().min(1),
  side: SideSchema,
  stop: StopInput,
  size: OrderIntentSchema.shape.size,
  leverage: OrderIntentSchema.shape.leverage.optional(),
  limit_px: z.number().finite().positive().optional(),
  target: z.number().finite().positive().optional(),
});
const DraftCloseInput = z.object({ coin: z.string().trim().min(1), pct: z.number().finite().gt(0).max(100) });

function ticketResult(t: Ticket): string {
  return [
    NOT_SENT,
    out({
      ticketId: t.id,
      network: t.network,
      action: t.action.kind,
      coin: t.coin,
      side: t.side,
      size: t.size == null ? null : sig(t.size),
      notionalUsd: t.notionalUsd == null ? null : usd(t.notionalUsd),
      entryPx: t.entryPx == null ? null : sig(t.entryPx),
      stopPx: t.stopPx == null ? null : sig(t.stopPx),
      tpPx: t.tpPx == null ? null : sig(t.tpPx),
      liqPx: t.liqPx == null ? null : sig(t.liqPx),
      riskUsd: t.riskUsd == null ? null : usd(t.riskUsd),
      riskPct: pct(t.riskPct),
      rr: pct(t.rr),
      leverage: t.leverage,
      slippageBps: pct(t.slippageBps),
      governor: t.verdict ? { approved: t.verdict.approved, reasons: t.verdict.reasons, warnings: t.verdict.warnings } : null,
      canSend: t.canSend,
      blockers: t.blockers,
      warnings: t.warnings,
    }),
  ].join("\n");
}

export function agentTools(deps: AgentDeps): AgentTool[] {
  const marketsAt = (s: AppState) => (s.marketsAt ? iso(s.marketsAt) : null);
  return [
    def(
      "get_markets",
      "Hyperliquid perp markets: price, 24h change, funding (APR %), open interest and volume in USD. Default top 20 by open interest.",
      {
        sort: { type: "string", enum: [...SORTS], description: "default oi" },
        limit: { type: "integer", minimum: 1, maximum: 40, description: "default 20" },
        coins: { type: "array", items: { type: "string" }, description: "only these coins (overrides sort/limit)" },
      },
      [],
      z.object({ sort: z.enum(SORTS).optional(), limit: z.number().int().min(1).max(40).optional(), coins: z.array(z.string().trim().min(1)).max(40).optional() }),
      (i) => {
        const s = deps.getState();
        const live = s.markets.filter((m) => !m.isDelisted);
        const rows = i.coins ? i.coins.map((c) => findMarket(s, c)) : [...live].sort(sorters[i.sort ?? "oi"]).slice(0, i.limit ?? 20);
        return out({ asOf: marketsAt(s), ...(s.marketsError ? { error: s.marketsError } : {}), total: live.length, markets: rows.map(marketRow) });
      },
    ),
    def(
      "get_coin",
      "Drill-in for one coin: market stats, ATR14 (daily), flow regime, trap/rally diagnostics, and the trader's position in it.",
      coinProp,
      ["coin"],
      CoinOnly,
      async (i) => {
        const s = deps.getState();
        const m = findMarket(s, i.coin);
        const v = await buildCoinView(deps.info, m, s.account, Date.now(), deps.oiSeries(m.coin));
        return out({
          asOf: marketsAt(s),
          market: {
            ...marketRow(m),
            fundingHourly: sig(m.fundingHourly, 4),
            predictedFundingHourly: m.predictedFundingHourly == null ? null : sig(m.predictedFundingHourly, 4),
            premium: m.premium == null ? null : sig(m.premium, 4),
            maxLeverage: m.maxLeverage,
          },
          atr14: v.atr14 == null ? null : sig(v.atr14),
          atr14Pct: v.atr14 == null ? null : pct((v.atr14 / m.markPx) * 100),
          regime: v.regime,
          diagnostics: v.diagnostics,
          position: v.position ? positionOut(v.position) : null,
        });
      },
    ),
    def(
      "get_book",
      "Order book for one coin: top levels, spread (bps), USD depth within 50 bps, and slippage (bps vs mid) to fill $10k / $50k / $250k.",
      coinProp,
      ["coin"],
      CoinOnly,
      async (i) => {
        const m = findMarket(deps.getState(), i.coin);
        const b = await deps.info.book(m.coin);
        const lv = (l: Array<{ px: number; sz: number }>) => l.slice(0, 5).map((x) => [sig(x.px), sig(x.sz)]);
        return out({
          coin: b.coin,
          asOf: iso(b.at),
          mid: b.mid == null ? null : sig(b.mid),
          spreadBps: pct(b.spreadBps),
          depth50BpsUsd: { bid: usd(b.depth50Usd.bid), ask: usd(b.depth50Usd.ask) },
          slippageBps: b.slippage.map((s) => ({ sizeUsd: s.sizeUsd, buy: pct(s.buyBps), sell: pct(s.sellBps) })),
          levelsFormat: "[px, size in coins]",
          bids: lv(b.bids),
          asks: lv(b.asks),
        });
      },
    ),
    def("get_positions", "The trader's account: equity, margin, open positions (with stop, TP, liquidation distance) and open orders.", {}, [], z.object({}), () => {
      const s = deps.getState();
      if (!s.config.account) return "no account configured: only market data is available";
      if (!s.account) return `account not loaded yet${s.accountError ? ` (${s.accountError})` : ""}`;
      return out({ ...accountOut(s.account), ...(s.accountError ? { error: s.accountError } : {}) });
    }),
    def("get_alerts", "Active alerts from the TUI's trigger engine (moves, extreme funding, OI swings, missing/near stops).", {}, [], z.object({}), () => {
      const s = deps.getState();
      return out({ count: s.alerts.length, alerts: s.alerts.map((a) => ({ level: a.level, title: a.title, detail: a.detail, at: iso(a.at) })) });
    }),
    def(
      "get_funding_history",
      "Hourly funding history for a coin: summary stats (APR %) and a downsampled series, oldest first.",
      { ...coinProp, hours: { type: "integer", minimum: 1, maximum: 720, description: "lookback, default 168" } },
      ["coin"],
      CoinOnly.extend({ hours: z.number().int().min(1).max(720).optional() }),
      async (i) => {
        const m = findMarket(deps.getState(), i.coin);
        const hours = i.hours ?? 168;
        const pts = await deps.info.fundingHistory(m.coin, Date.now() - hours * HOUR);
        if (!pts.length) return out({ coin: m.coin, hours, points: 0, note: "no funding history returned" });
        const apr = (r: number) => r * 24 * 365 * 100;
        const aprs = pts.map((p) => apr(p.rate));
        const step = Math.max(1, Math.ceil(pts.length / 24));
        const series = pts.filter((_, k) => k % step === 0 || k === pts.length - 1).map((p) => [iso(p.t), pct(apr(p.rate))]);
        return out({
          coin: m.coin,
          hours,
          points: pts.length,
          latestAprPct: pct(aprs[aprs.length - 1]),
          meanAprPct: pct(aprs.reduce((a, b) => a + b, 0) / aprs.length),
          minAprPct: pct(Math.min(...aprs)),
          maxAprPct: pct(Math.max(...aprs)),
          seriesFormat: "[time, funding APR %]",
          series,
        });
      },
    ),
    def(
      "get_candles",
      "OHLCV candles for a coin, oldest first, as [time, open, high, low, close, volume in coins].",
      {
        ...coinProp,
        interval: { type: "string", enum: ["1h", "4h", "1d"] },
        bars: { type: "integer", minimum: 1, maximum: 200, description: "default 48" },
      },
      ["coin", "interval"],
      CoinOnly.extend({ interval: z.enum(["1h", "4h", "1d"]), bars: z.number().int().min(1).max(200).optional() }),
      async (i) => {
        const m = findMarket(deps.getState(), i.coin);
        const bars = i.bars ?? 48;
        const step = i.interval === "1h" ? HOUR : i.interval === "4h" ? 4 * HOUR : 24 * HOUR;
        const all = await deps.info.candles(m.coin, i.interval, Date.now() - (bars + 2) * step);
        if (!all.length) return out({ coin: m.coin, interval: i.interval, bars: 0, note: "no candles returned" });
        const c = all.slice(-bars);
        return out({ coin: m.coin, interval: i.interval, bars: c.length, format: "[time, o, h, l, c, v]", candles: c.map((k) => [iso(k.t), sig(k.o), sig(k.h), sig(k.l), sig(k.c), sig(k.v, 4)]) });
      },
    ),
    def("lab_pulse", "Hypertrade Lab market pulse: per asset, how many catalogued long/short rules are firing now, and which. Errors when the Lab is not configured.", {}, [], z.object({}), async () => {
      const raw = await deps.pulse();
      const p = PulseSchema.safeParse(raw);
      if (!p.success) return out(raw);
      return out({
        asOf: p.data.asOf,
        warnings: p.data.warnings,
        assets: p.data.assets.map((a) => ({
          asset: a.asset,
          long: `${a.longActive}/${a.longTotal}`,
          short: `${a.shortActive}/${a.shortTotal}`,
          lean: pct(a.lean),
          firing: a.rules.filter((r) => r.firing).map((r) => ({ name: r.name, direction: r.direction, rule: r.text })),
        })),
      });
    }),
    def("get_brief", "The routine's latest market brief from the repo: headline, tldr, regime, risks and top sectors (date-stamped; may be a day old).", {}, [], z.object({}), async () => {
      const b = await deps.brief();
      return b == null ? "no brief available: data/marketstate/latest.json not found" : out(b);
    }),
    def(
      "draft_order",
      "Draft an OPEN order and show the resulting ticket to the human for confirmation. Nothing is sent; only the human can confirm. Call only when the human asked for a trade. Requires coin, side, stop and size.",
      {
        ...coinProp,
        side: { type: "string", enum: ["long", "short"] },
        stop: {
          type: "object",
          description: 'Stop loss. {"type":"pct","pct":2} = 2% from entry; {"type":"price","px":N}; {"type":"atr_mult","mult":1.5}; {"type":"prev_day_low"}; {"type":"prev_day_high"}',
          properties: { type: { type: "string", enum: ["price", "pct", "prev_day_low", "prev_day_high", "atr_mult"] }, px: { type: "number" }, pct: { type: "number" }, mult: { type: "number" } },
          required: ["type"],
        },
        size: {
          type: "object",
          description: 'Position size. {"usd": notional USD} or {"pctBook": percent of account equity as notional}. Required.',
          properties: { usd: { type: "number" }, pctBook: { type: "number" } },
        },
        leverage: { type: "number", description: "default: the configured default leverage" },
        limit_px: { type: "number", description: "limit entry price; omit for market" },
        target: { type: "number", description: "take-profit price" },
      },
      ["coin", "side", "stop", "size"],
      DraftOrderInput,
      async (i) => {
        const s = deps.getState();
        const m = findMarket(s, i.coin);
        const candidate: OrderIntent = {
          asset: m.coin,
          side: i.side,
          leverage: i.leverage ?? s.config.defaultLeverage,
          size: i.size,
          entry: i.limit_px ? { type: "limit", px: i.limit_px } : { type: "market" },
          stop: i.stop,
          ...(i.target ? { target: i.target } : {}),
        };
        const v = OrderIntentSchema.safeParse(candidate);
        if (!v.success) throw new Error(zodMessage("draft_order", v.error));
        return ticketResult(await deps.draftOrder({ kind: "open", intent: v.data }));
      },
    ),
    def(
      "draft_close",
      "Draft a reduce-only CLOSE of part or all of an open position and show the ticket to the human. Nothing is sent. Call only when the human asked to close.",
      { ...coinProp, pct: { type: "number", description: "percent of the position to close, 0 < pct <= 100" } },
      ["coin", "pct"],
      DraftCloseInput,
      async (i) => {
        const s = deps.getState();
        const m = findMarket(s, i.coin);
        if (s.account && !s.account.positions.some((p) => p.coin === m.coin)) throw new Error(`no open ${m.coin} position to close`);
        return ticketResult(await deps.draftOrder({ kind: "close", coin: m.coin, pct: i.pct }));
      },
    ),
  ];
}
