import { z } from "zod";
import type { ToolSpec } from "../llm/provider.js";
import { runTool as runAnalystTool, TOOL_SPECS as ANALYST_SPECS, type ToolDeps, defaultToolDeps } from "../llm/tools.js";
import { marketBreadth, mean, rallyDiagnostics, stdev } from "./analytics.js";
import { trimForModel } from "./data.js";
import { DeskService } from "./service.js";
import { ExitProposalSchema, TradeProposalSchema, type DeskEvent } from "./types.js";

// The desk agents' tools. Read tools are shared by every agent; action
// tools (propose_trade, propose_exit, send_alert) go only to the portfolio
// manager, and every action passes the governor in service.ts. The
// orchestration tools (consult_specialists, spawn_agent) live in agents.ts.

export const MAX_TOOL_CHARS = 14_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface ToolContext {
  service: DeskService;
  runId: string | null;
  agent: string;
  emit(e: DeskEvent): void;
  /** Per-run counters shared across agents (proposal and alert budgets). */
  budget: { proposals: number; alerts: number };
  analystDeps?: ToolDeps;
}

export interface ToolRun {
  content: string;
  summary: string;
  isError: boolean;
}

export interface DeskTool {
  spec: ToolSpec;
  kind: "read" | "action";
  run(input: unknown, ctx: ToolContext): Promise<ToolRun>;
}

export const MAX_PROPOSALS_PER_RUN = 3;
export const MAX_ALERTS_PER_RUN = 3;

function clip(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length <= MAX_TOOL_CHARS ? s : `${s.slice(0, MAX_TOOL_CHARS)}…[truncated]`;
}
const ok = (v: unknown, summary: string): ToolRun => ({ content: clip(v), summary, isError: false });
const fail = (summary: string, detail: Record<string, unknown> = {}): ToolRun => ({ content: JSON.stringify({ error: summary, ...detail }), summary, isError: true });

/** Wraps a zod-validated handler so bad input becomes a readable tool error. */
function tool<S extends z.ZodTypeAny>(kind: DeskTool["kind"], spec: ToolSpec, schema: S, fn: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolRun>): DeskTool {
  return {
    spec,
    kind,
    async run(raw, ctx) {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) return fail("invalid input", { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      try {
        return await fn(parsed.data, ctx);
      } catch (err) {
        return fail(`${spec.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

const r = (x: number, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = mean(values.slice(0, period));
  for (const v of values.slice(period)) e = v * k + e * (1 - k);
  return e;
}

export function atr(bars: Array<{ h: number; l: number; c: number }>, period = 14): number | null {
  if (bars.length <= period) return null;
  const trs = bars.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - bars[i]!.c), Math.abs(b.l - bars[i]!.c)));
  return mean(trs.slice(-period));
}

/** FRED ids the collector stores (collectors/fred.ts) plus its two derived series. */
export const MACRO_SERIES: Array<{ id: string; label: string }> = [
  { id: "fred.net_liquidity", label: "Fed net liquidity (WALCL − TGA − RRP)" },
  { id: "fred.WALCL", label: "Fed balance sheet" },
  { id: "fred.WTREGEN", label: "Treasury General Account" },
  { id: "fred.RRPONTSYD", label: "Reverse repo" },
  { id: "fred.DGS2", label: "2Y yield" },
  { id: "fred.DGS10", label: "10Y yield" },
  { id: "fred.spread_2s10s", label: "2s10s spread" },
  { id: "fred.T10YIE", label: "10Y breakeven inflation" },
  { id: "fred.SOFR", label: "SOFR" },
  { id: "fred.DTWEXBGS", label: "Broad dollar index" },
  { id: "fred.BAMLH0A0HYM2", label: "HY credit spread" },
  { id: "fred.VIXCLS", label: "VIX" },
  { id: "fred.DCOILWTICO", label: "WTI crude" },
];

const empty = { type: "object" as const, properties: {}, additionalProperties: false };
const coinProp = { type: "string", description: "Hyperliquid perp name, e.g. BTC, ETH, HYPE, kPEPE" };

export const READ_TOOLS: DeskTool[] = [
  tool(
    "read",
    {
      name: "flow_diagnostics",
      description:
        "Decomposes a coin's recent move into who drove it: price vs open-interest change (new longs, short covering, liquidation, spot-led), funding level and z-score vs its 30-day history, perp premium vs oracle, volume trend vs the prior window, share of volume on bars closing with the move, realized vol and extension. Returns a flow regime and a 0-100 trap score with each component's points and reason. The main tool for 'is this rally/selloff real flow or a trap'.",
      input_schema: {
        type: "object",
        properties: { coin: coinProp, window_hours: { type: "integer", minimum: 6, maximum: 336, description: "length of the move to inspect (default 72)" } },
        required: ["coin"],
        additionalProperties: false,
      },
    },
    z.object({ coin: z.string().min(1).max(20), window_hours: z.number().int().min(6).max(336).optional() }).strict(),
    async (input, ctx) => {
      const { service } = ctx;
      const ctxs = await service.data.ctxs();
      const market = DeskService.findMarket(ctxs, input.coin);
      if (!market) return fail(`${input.coin} is not a listed Hyperliquid perp`);
      const coin = market.coin;
      const w = input.window_hours ?? 72;
      const now = service.now().getTime();
      const [candles, funding, oi] = await Promise.all([
        service.data.candles(coin, "1h", now - (2 * w + 2) * HOUR, now),
        service.data.funding(coin, now - w * HOUR - 30 * DAY, now),
        service.data.series(`hl.oi.${coin}`, new Date(now - (w + 6) * HOUR)).catch(() => []),
      ]);
      const assetCtx = ctxs.find((c) => c.name === coin);
      const d = rallyDiagnostics({ coin, windowHours: w, candles, funding, oi, now, ctx: assetCtx });
      return ok(d, `${coin} ${w}h: ${d.regime}, trap ${d.trapScore} (${d.label})`);
    },
  ),
  tool(
    "read",
    {
      name: "market_breadth",
      description:
        "Breadth across the top Hyperliquid perps by open interest: % advancing over 24h, median 24h change, BTC's lead over the median alt, OI-weighted funding (APR %), and the hottest/coldest funding coins. Tells whether a move is broad participation or a few names.",
      input_schema: { type: "object", properties: { top: { type: "integer", minimum: 10, maximum: 150, description: "sample size (default 50)" } }, additionalProperties: false },
    },
    z.object({ top: z.number().int().min(10).max(150).optional() }).strict(),
    async (input, ctx) => {
      const b = marketBreadth(await ctx.service.data.ctxs(), input.top ?? 50);
      return ok(b, `${b.advancingPct}% advancing, BTC lead ${b.btcLeadPct}%, funding ${b.oiWeightedFundingApr}% APR`);
    },
  ),
  tool(
    "read",
    {
      name: "macro_dashboard",
      description:
        "US macro and liquidity from FRED (collected daily): Fed net liquidity (balance sheet − TGA − reverse repo) and its parts, 2Y/10Y yields and the 2s10s spread, breakevens, SOFR, the broad dollar, HY credit spreads, VIX and crude. Each with latest value, date, and change over ~1 and ~3 months. Use for 'does liquidity/macro support this move'; fiscal policy news needs web search on top.",
      input_schema: empty,
    },
    z.object({}).strict(),
    async (_input, ctx) => {
      const now = ctx.service.now().getTime();
      const rows = await Promise.all(
        MACRO_SERIES.map(async ({ id, label }) => {
          const pts = await ctx.service.data.series(id, new Date(now - 110 * DAY)).catch(() => []);
          if (!pts.length) return { id, label, latest: null };
          const last = pts[pts.length - 1]!;
          const at = (days: number) => {
            const t = last.t - days * DAY;
            let v: number | null = null;
            for (const p of pts) if (p.t <= t) v = p.v;
            return v;
          };
          const m1 = at(30);
          const m3 = at(90);
          return {
            id,
            label,
            latest: r(last.v, 4),
            date: new Date(last.t).toISOString().slice(0, 10),
            chg1m: m1 == null ? null : r(last.v - m1, 4),
            chg3m: m3 == null ? null : r(last.v - m3, 4),
          };
        }),
      );
      const have = rows.filter((x) => x.latest != null).length;
      if (!have) return fail("no FRED series collected yet (FRED_API_KEY unset or the collector has not run)");
      return ok({ series: rows, note: "yields/spreads in percent; liquidity components in USD millions as FRED publishes them" }, `${have}/${rows.length} macro series`);
    },
  ),
  tool(
    "read",
    {
      name: "price_structure",
      description:
        "Price structure for setting levels: last price, 7d and 30d highs/lows, daily EMA20/50/200, daily ATR(14) in price and percent, distance from each EMA, and the last 12 bars of the chosen interval (4h or 1d).",
      input_schema: {
        type: "object",
        properties: { coin: coinProp, interval: { type: "string", enum: ["4h", "1d"], description: "bars to return (default 4h)" } },
        required: ["coin"],
        additionalProperties: false,
      },
    },
    z.object({ coin: z.string().min(1).max(20), interval: z.enum(["4h", "1d"]).optional() }).strict(),
    async (input, ctx) => {
      const ctxs = await ctx.service.data.ctxs();
      const market = DeskService.findMarket(ctxs, input.coin);
      if (!market) return fail(`${input.coin} is not a listed Hyperliquid perp`);
      const now = ctx.service.now().getTime();
      const interval = input.interval ?? "4h";
      const [daily, bars] = await Promise.all([
        ctx.service.data.candles(market.coin, "1d", now - 260 * DAY, now),
        interval === "1d" ? Promise.resolve(null) : ctx.service.data.candles(market.coin, "4h", now - 8 * DAY, now),
      ]);
      if (daily.length < 2) return fail(`no daily history for ${market.coin}`);
      const closes = daily.map((c) => c.c);
      const last = market.markPx;
      const range = (days: number) => {
        const sl = daily.filter((c) => c.t >= now - days * DAY);
        return { high: Math.max(...sl.map((c) => c.h)), low: Math.min(...sl.map((c) => c.l)) };
      };
      const emas = { ema20: ema(closes, 20), ema50: ema(closes, 50), ema200: ema(closes, 200) };
      const a = atr(daily);
      const out = {
        coin: market.coin,
        last,
        range7d: range(7),
        range30d: range(30),
        ...Object.fromEntries(Object.entries(emas).map(([k, v]) => [k, v == null ? null : { value: r(v, 6), distPct: r(((last - v) / v) * 100) }])),
        atr14d: a == null ? null : { value: r(a, 6), pct: r((a / last) * 100) },
        bars: (bars ?? daily).slice(-12).map((c) => ({ t: new Date(c.t).toISOString().slice(0, 16), o: c.o, h: c.h, l: c.l, c: c.c, v: r(c.v, 2) })),
      };
      return ok(out, `${market.coin} @ ${last}, ATR ${out.atr14d?.pct ?? "n/a"}%`);
    },
  ),
  tool(
    "read",
    {
      name: "funding_history",
      description: "Hourly funding for one coin over N days: mean, stdev, min/max (APR %), share of hours positive, and the daily means — for judging whether current funding is unusual.",
      input_schema: {
        type: "object",
        properties: { coin: coinProp, days: { type: "integer", minimum: 1, maximum: 60, description: "default 14" } },
        required: ["coin"],
        additionalProperties: false,
      },
    },
    z.object({ coin: z.string().min(1).max(20), days: z.number().int().min(1).max(60).optional() }).strict(),
    async (input, ctx) => {
      const market = DeskService.findMarket(await ctx.service.data.ctxs(), input.coin);
      if (!market) return fail(`${input.coin} is not a listed Hyperliquid perp`);
      const days = input.days ?? 14;
      const now = ctx.service.now().getTime();
      const pts = await ctx.service.data.funding(market.coin, now - days * DAY, now);
      if (!pts.length) return fail(`no funding history for ${market.coin}`);
      const apr = (x: number) => r(x * 24 * 365 * 100);
      const rates = pts.map((p) => p.rate);
      const byDay = new Map<string, number[]>();
      for (const p of pts) {
        const k = new Date(p.t).toISOString().slice(0, 10);
        byDay.set(k, [...(byDay.get(k) ?? []), p.rate]);
      }
      return ok(
        {
          coin: market.coin,
          hours: pts.length,
          meanApr: apr(mean(rates)),
          stdevApr: apr(stdev(rates)),
          minApr: apr(Math.min(...rates)),
          maxApr: apr(Math.max(...rates)),
          positiveShare: r(rates.filter((x) => x > 0).length / rates.length, 3),
          daily: [...byDay].map(([d, xs]) => ({ day: d, meanApr: apr(mean(xs)) })),
        },
        `${market.coin} funding ${days}d mean ${apr(mean(rates))}% APR`,
      );
    },
  ),
  tool(
    "read",
    {
      name: "cycle_regime",
      description:
        "Bitcoin cycle and on-chain regime from the hl-cycles dashboard: regime, Market Compass score and conditions (MVRV, STH/LTH realized price, SOPR, ETF flows, stablecoin supply, DVOL, options skew, macro inputs). Long-horizon context; only available when DESK_CYCLES_URL is set.",
      input_schema: empty,
    },
    z.object({}).strict(),
    async (_input, ctx) => {
      const url = ctx.service.config.cyclesUrl;
      if (!url) return fail("hl-cycles not connected (DESK_CYCLES_URL unset); say on-chain/cycle context is unavailable");
      const v = await ctx.service.data.cycles(url, "vector.json");
      return ok(trimForModel(v, 6), "hl-cycles vector");
    },
  ),
  tool(
    "read",
    {
      name: "portfolio",
      description:
        "The desk's book: equity, day PnL, open positions with entry, mark, stop, target and unrealized PnL, open stop-risk, the governor's limits, the kill switch and approval mode. Also the operator's watched Hyperliquid account when one is configured (read-only).",
      input_schema: empty,
    },
    z.object({}).strict(),
    async (_input, ctx) => {
      const s = ctx.service;
      const [account, watched, kill, approval] = await Promise.all([s.account(), s.watchedAccount(), s.killSwitch(), s.approval()]);
      return ok(
        { desk: account, watched, killSwitch: kill, approval, venue: s.broker.venue, limits: s.config.limits },
        `equity $${account.equityUsd.toFixed(0)}, ${account.positions.length} positions${watched ? `; watched $${watched.equityUsd.toFixed(0)}` : ""}`,
      );
    },
  ),
  tool(
    "read",
    {
      name: "desk_history",
      description: "The desk's recent proposals (with governor verdicts and outcomes) and paper fills with realized PnL, newest first. Use it to stay consistent with earlier calls and to review what worked.",
      input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 30, description: "default 10" } }, additionalProperties: false },
    },
    z.object({ limit: z.number().int().min(1).max(30).optional() }).strict(),
    async (input, ctx) => {
      const n = input.limit ?? 10;
      const [proposals, fills] = await Promise.all([ctx.service.store.listProposals({ limit: n }), ctx.service.store.listFills(n)]);
      return ok(
        {
          proposals: proposals.map((p) => ({
            id: p.id,
            at: p.createdAt,
            kind: p.kind,
            status: p.status,
            proposal: p.proposal,
            reasons: p.verdict.reasons,
            sizing: p.verdict.sizing,
          })),
          fills,
        },
        `${proposals.length} proposals, ${fills.length} fills`,
      );
    },
  ),
];

/** The analyst's read tools (briefing, sectors, metrics, series, HL markets), reused as-is. */
const REUSED = new Set(["get_marketstate", "get_sectors", "get_metrics_summary", "get_series", "get_hl_markets", "web_search"]);
export const ANALYST_TOOLS: DeskTool[] = ANALYST_SPECS.filter((s) => REUSED.has(s.name)).map((spec) => ({
  spec,
  kind: "read" as const,
  run: (input, ctx) => runAnalystTool(spec.name, input, ctx.analystDeps ?? defaultToolDeps),
}));

const tradeSchemaJson = {
  type: "object",
  properties: {
    coin: coinProp,
    side: { type: "string", enum: ["long", "short"] },
    setup: { type: "string", description: "short label, e.g. 'short-covering fade', 'spot-led breakout retest'" },
    thesis: { type: "string", description: "why, in 2-6 sentences, citing the evidence" },
    horizon: { type: "string", enum: ["intraday", "swing", "position"] },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    stop: { type: "number", description: "stop-loss price (required; where the thesis is wrong)" },
    target: { type: "number", description: "take-profit price" },
    riskPct: { type: "number", minimum: 0.05, maximum: 2, description: "percent of equity lost if the stop fills; the governor sizes from this and may clip it" },
    entryLimit: { type: "number", description: "worst acceptable entry price; omit to accept the live mark" },
    invalidation: { type: "string", description: "what would prove the thesis wrong before the stop" },
    evidence: {
      type: "array",
      minItems: 2,
      maxItems: 12,
      items: {
        type: "object",
        properties: { source: { type: "string", description: "tool or specialist, e.g. flow_diagnostics, macro specialist" }, point: { type: "string" } },
        required: ["source", "point"],
        additionalProperties: false,
      },
    },
  },
  required: ["coin", "side", "setup", "thesis", "horizon", "confidence", "stop", "target", "riskPct", "invalidation", "evidence"],
  additionalProperties: false,
};

export const ACTION_TOOLS: DeskTool[] = [
  tool(
    "action",
    {
      name: "propose_trade",
      description:
        "Submit a new position to the governor. The governor recomputes size from equity, riskPct and the stop at the live mark, enforces the risk limits (per-trade and open risk, leverage, reward:risk ≥ the minimum, stop distance, daily loss, kill switch, one position per coin) and then either executes on the desk's venue, queues it for the operator's approval, or blocks it with reasons. Read the returned verdict; a block is final for this exact proposal. At most 3 proposals per run.",
      input_schema: tradeSchemaJson as ToolSpec["input_schema"],
    },
    TradeProposalSchema,
    async (input, ctx) => {
      if (ctx.budget.proposals >= MAX_PROPOSALS_PER_RUN) return fail(`proposal budget for this run is spent (${MAX_PROPOSALS_PER_RUN})`);
      ctx.budget.proposals++;
      const rec = await ctx.service.submitOpen(input, ctx.runId);
      ctx.emit({ type: "proposal", agent: ctx.agent, id: rec.id, kind: "open", status: rec.status, coin: input.coin, summary: `${input.side} ${input.coin}: ${input.setup}` });
      return ok({ id: rec.id, status: rec.status, verdict: rec.verdict, execution: rec.execution }, `${input.side} ${input.coin} → ${rec.status}`);
    },
  ),
  tool(
    "action",
    {
      name: "propose_exit",
      description: "Close all or part of an open desk position (reduce-only; exits never wait for approval and are allowed under the kill switch).",
      input_schema: {
        type: "object",
        properties: {
          coin: coinProp,
          fraction: { type: "number", exclusiveMinimum: 0, maximum: 1, description: "1 closes the whole position" },
          reason: { type: "string" },
        },
        required: ["coin", "fraction", "reason"],
        additionalProperties: false,
      },
    },
    ExitProposalSchema,
    async (input, ctx) => {
      if (ctx.budget.proposals >= MAX_PROPOSALS_PER_RUN) return fail(`proposal budget for this run is spent (${MAX_PROPOSALS_PER_RUN})`);
      ctx.budget.proposals++;
      const rec = await ctx.service.submitExit(input, ctx.runId);
      ctx.emit({ type: "proposal", agent: ctx.agent, id: rec.id, kind: "exit", status: rec.status, coin: input.coin, summary: `exit ${Math.round(input.fraction * 100)}% ${input.coin}` });
      return ok({ id: rec.id, status: rec.status, verdict: rec.verdict, execution: rec.execution }, `exit ${input.coin} → ${rec.status}`);
    },
  ),
  tool(
    "action",
    {
      name: "send_alert",
      description:
        "Push an alert to the operator (Telegram/Discord/webhook as configured, and the Desk page). For things they should know now: a regime change, a position at risk, a setup forming. Not for routine summaries. At most 3 per run.",
      input_schema: {
        type: "object",
        properties: {
          level: { type: "string", enum: ["info", "warn", "critical"] },
          title: { type: "string", maxLength: 120 },
          body: { type: "string", maxLength: 1500 },
        },
        required: ["level", "title", "body"],
        additionalProperties: false,
      },
    },
    z.object({ level: z.enum(["info", "warn", "critical"]), title: z.string().min(3).max(120), body: z.string().min(3).max(1500) }).strict(),
    async (input, ctx) => {
      if (ctx.budget.alerts >= MAX_ALERTS_PER_RUN) return fail(`alert budget for this run is spent (${MAX_ALERTS_PER_RUN})`);
      ctx.budget.alerts++;
      await ctx.service.alert(input.level, input.title, input.body, ctx.runId);
      ctx.emit({ type: "alert", agent: ctx.agent, level: input.level, title: input.title });
      return ok({ sent: true }, `alert: ${input.title}`);
    },
  ),
];

export const ALL_READ_TOOLS: DeskTool[] = [...READ_TOOLS, ...ANALYST_TOOLS];
export const READ_TOOL_NAMES = ALL_READ_TOOLS.map((t) => t.spec.name);

export function toolByName(name: string): DeskTool | undefined {
  return [...ALL_READ_TOOLS, ...ACTION_TOOLS].find((t) => t.spec.name === name);
}
