import { FORECAST_RULE, HEDGE_VOCABULARY } from "./system.js";
import { toolCatalog, withDeadline, type ToolRun } from "./tools.js";
import type { ToolSpec } from "./provider.js";
import { getCtxs } from "../routes/hl.js";
import { runIntent, type IntentDeps } from "../sim/intent.js";
import { realDeps } from "../sim/run.js";
import type { SimBranchOutcome, SimIntent } from "../../shared/intent.js";
import { UpstreamError } from "../mcp/types.js";

// Sim mode of the analyst (docs/SPEC.md "Paths", decisions 2/5/7/9). The JSON schema
// below is only a hint for the model; SimIntentSchema (zod, inside runIntent) is
// the authority.

const SIM_DEADLINE_MS = 40_000;

const allocation = {
  type: "object",
  additionalProperties: false,
  required: ["coin", "weightPct"],
  properties: {
    coin: { type: "string", maxLength: 24, pattern: "^([A-Za-z0-9]+:)?[A-Za-z0-9]+$", description: "Hyperliquid coin symbol (BTC, ETH, SOL, ...) or USDC/USDT for cash." },
    weightPct: { type: "number", minimum: 0, description: "Percent of starting capital (weights should sum to 100). For a perp leg this is the margin put up." },
    side: { type: "string", enum: ["long", "short"], description: "Default long. short makes it a perp leg. Stablecoins cannot be short." },
    leverage: { type: "number", minimum: 1, maximum: 50, description: "Default 1 (spot). Above 1 makes it a perp leg: notional = margin x leverage. Stablecoins cannot be levered." },
  },
};

export const SIM_TOOL_SPEC: ToolSpec = {
  name: "simulate_paths",
  description:
    "Run 1-4 historical portfolio simulations (branches) and compare them. Spot or perp legs, optional rebalancing, DCA, trading costs, recurring deposits/withdrawals and a forward Monte Carlo scenario. Results are historical; fees and funding are only charged when costs is set. Returns per-branch stats, rolling start-date windows and the projection summary; the full curves are shown to the user separately.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "assumptions", "branches"],
    properties: {
      title: { type: "string", maxLength: 120 },
      assumptions: {
        type: "array",
        maxItems: 12,
        items: { type: "string", maxLength: 300 },
        description: "Every inference you made from loose wording (stack size, start date, coin choice, DCA funding...).",
      },
      branches: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "config"],
          properties: {
            name: { type: "string", maxLength: 80 },
            config: {
              type: "object",
              additionalProperties: false,
              required: ["startDate", "initialCapitalUsd", "allocations", "rebalance"],
              properties: {
                description: { type: "string" },
                startDate: { type: "string", description: "ISO date, e.g. 2025-01-01. Moved forward if a coin has no earlier price data." },
                initialCapitalUsd: { type: "number", exclusiveMinimum: 0, maximum: 1e12, description: "Default 10000 when the user states no amount." },
                allocations: { type: "array", maxItems: 10, items: allocation },
                rebalance: { type: "string", enum: ["none", "monthly", "weekly", "threshold5pct"], description: "Forced to none when dca is present." },
                dca: {
                  type: "array",
                  maxItems: 8,
                  description: "Self-financed from the USDC/USDT sleeve (no new cash enters), so allocate USDC weight to fund it. It stops when the sleeve is empty.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["coin", "amountUsd", "every"],
                    properties: {
                      coin: { type: "string", maxLength: 24, pattern: "^([A-Za-z0-9]+:)?[A-Za-z0-9]+$" },
                      amountUsd: { type: "number", exclusiveMinimum: 0 },
                      every: { type: "string", enum: ["weekly", "monthly"] },
                    },
                  },
                },
                costs: {
                  type: "object",
                  additionalProperties: false,
                  required: ["feeBps"],
                  description: "Trading costs. feeBps is charged on every traded notional (entry, rebalance, DCA, deposits, withdrawals); fundingAprPct is charged daily on perp notional (longs pay a positive rate, shorts receive it).",
                  properties: { feeBps: { type: "number", minimum: 0, maximum: 500 }, fundingAprPct: { type: "number", minimum: -200, maximum: 200 } },
                },
                cashflow: {
                  type: "object",
                  additionalProperties: false,
                  required: ["amountUsd", "every"],
                  description: "External money on a schedule: positive adds cash at the target weights, negative withdraws pro rata. Continues into the projection. Return stats are then time-weighted.",
                  properties: { amountUsd: { type: "number" }, every: { type: "string", enum: ["weekly", "monthly"] } },
                },
                rollingWindowDays: { type: "integer", minimum: 0, maximum: 1825, description: "Length of the rolling start-date windows (the same strategy started on many past dates). Default: 365/90/30 days, whichever fits twice in the history; 0 turns it off." },
                scenario: {
                  type: "object",
                  additionalProperties: false,
                  required: ["horizonDays", "assumptions", "paths"],
                  description: "Forward Monte Carlo fan from today. method gbm (default) uses the typed assumptions and only fits unlevered long-only branches (dropped otherwise); method bootstrap resamples blocks of the branch's own simulated daily returns (assumptions may be []) and works for perp legs.",
                  properties: {
                    horizonDays: { type: "integer", minimum: 1, maximum: 3650 },
                    paths: { type: "integer", minimum: 1 },
                    method: { type: "string", enum: ["gbm", "bootstrap"] },
                    blockDays: { type: "integer", minimum: 1, maximum: 90, description: "bootstrap block length, default 10" },
                    targetUsd: { type: "number", exclusiveMinimum: 0, description: "Reports the share of paths ending at or above it." },
                    assumptions: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["coin", "annualReturnPct", "annualVolPct"],
                        properties: { coin: { type: "string" }, annualReturnPct: { type: "number" }, annualVolPct: { type: "number" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function buildSimSystemPrompt(webSearch: boolean): string {
  const tools = toolCatalog(webSearch)
    .map((t) => `- ${t.name}${t.available ? "" : " (unavailable)"}${t.note ? ` — ${t.note}` : ""}`)
    .join("\n");
  return `You are the Hypertrade simulation assistant: you turn a loose portfolio idea into historical simulations for one operator, inside a personal market terminal. You can read the app's market data but never place, approve or change anything.

${HEDGE_VOCABULARY}

${FORECAST_RULE}

Simulation rules:
- Always call simulate_paths before quoting any number. Never compute or guess results yourself.
- Results are historical simulation, not a forecast. Say so, and relay each branch's warnings.
- When the idea is open-ended ("hedge my ETH"), run 2-3 contrasting branches in one call (for example unhedged vs 50% hedge vs full hedge).
- Ask a one-line clarifying question only when no reasonable default exists; otherwise assume and proceed.
- There is no holdings source: default to a $10,000 stack unless the user states an amount, and turn implicit holdings ("my ETH") into explicit allocations. Put every inference (stack size, start date, coins, DCA funding) in "assumptions".
- Weights are percent of starting capital and should sum to 100. A perp leg's weight is its margin; leverage multiplies the notional. DCA is self-financed from the USDC sleeve, so give USDC a weight large enough to fund it.
- startDate is an ISO date. The question carries [current time ...]; resolve "since January" or "last year" against it. A start earlier than a coin's first candle is moved forward and reported in warnings.
- Earlier assistant turns may end with a "[paths]" trailer holding each path's normalized config. For follow-ups ("same but 5x", "without the DCA"), modify those configs instead of re-guessing.
- Perp legs liquidate on daily lows/highs and, without costs, ignore funding and fees; the tool's warnings say so. Report them. When the user asks about realistic or net results, set costs (Hyperliquid taker fees are about 4.5 bps).
- Wealth questions ("if I add $500 a month", "can I withdraw $2k a month") use cashflow. With a cashflow, quote twrPct/cagrPct for performance and finalValue/netFlowUsd for wealth; they answer different questions.
- "rolling" says how the same strategy did from every past start date over a fixed window: quote its median and worst, and the share of starts that beat BTC, when timing luck matters.
- For "what could happen" questions add a scenario. Prefer method bootstrap (it replays the branch's own history, including perp legs and costs); use gbm only when the user gives return and volatility assumptions. Quote the projection summary as a spread (p10/median/p90, lossPct, targetPct), never a single number.
- Be dense and specific: short paragraphs or tight bullets, numbers with units.

Tools:
${tools}
- simulate_paths — historical portfolio simulation (1-4 branches)`;
}

/** Real deps for sim mode; the HL universe (canonical names, max leverage) comes from the cached
 * universe fetch, bounded to `ms`; on failure or timeout coins are just uppercased and the schema cap (50x) applies. */
export async function realSimDeps(load = getCtxs, ms = 5000): Promise<IntentDeps> {
  let byName: Map<string, { name: string; maxLeverage?: number }> | undefined;
  try {
    const { ctxs } = await withDeadline(load(), ms, "hyperliquid universe");
    byName = new Map(ctxs.map((c) => [c.name.toUpperCase(), c]));
  } catch {
    // HL unreachable or slow: no coin check, schema cap applies
  }
  if (!byName) return { ...realDeps };
  const map = byName;
  return { ...realDeps, maxLeverage: (coin) => map.get(coin.toUpperCase())?.maxLeverage, resolveCoin: (coin) => map.get(coin.toUpperCase())?.name };
}

const round = (n: number) => Math.round(n * 100) / 100;

const opt = (n: number | undefined) => (n === undefined ? undefined : round(n));

function compact(b: SimBranchOutcome) {
  const r = b.result;
  const s = r?.stats;
  const cap = b.config.initialCapitalUsd;
  const roll = r?.rolling;
  const proj = r?.montecarlo?.summary;
  return {
    name: b.name,
    finalValue: s && round(s.finalValue),
    totalReturnPct: s && cap > 0 ? round((s.finalValue / cap - 1) * 100) : undefined,
    twrPct: opt(s?.twrPct),
    cagrPct: s && round(s.cagrPct),
    maxDrawdownPct: s && round(s.maxDrawdownPct),
    vsBtcPct: s && round(s.vsBtcPct),
    volPct: opt(s?.volPct),
    sharpe: opt(s?.sharpe),
    feesUsd: s?.feesUsd ? round(s.feesUsd) : undefined,
    fundingUsd: s?.fundingUsd ? round(s.fundingUsd) : undefined,
    netFlowUsd: s?.netFlowUsd ? round(s.netFlowUsd) : undefined,
    rolling: roll && {
      windowDays: roll.windowDays,
      starts: roll.summary.n,
      medianPct: round(roll.summary.median),
      worstPct: round(roll.summary.worst),
      bestPct: round(roll.summary.best),
      positivePct: round(roll.summary.positivePct),
      beatBtcPct: round(roll.summary.beatBtcPct),
    },
    projection: proj && {
      method: proj.method,
      horizonDays: b.config.scenario?.horizonDays,
      investedUsd: round(proj.investedUsd),
      p10: round(proj.finalP10),
      median: round(proj.finalMedian),
      p90: round(proj.finalP90),
      lossPct: round(proj.lossPct),
      targetPct: opt(proj.targetPct),
      depletedPct: opt(proj.depletedPct),
    },
    startDate: b.config.startDate,
    warnings: [...b.warnings, ...(r?.notes ?? [])],
    error: b.error,
  };
}

/** Runs one simulate_paths call: emits sim_result (before the caller emits tool_result) and returns the compact tool content. */
export async function runSimTool(
  call: { id: string; input: unknown },
  deps: IntentDeps,
  emitResult: (e: { type: "sim_result"; id: string; intent: SimIntent; branches: SimBranchOutcome[] }) => Promise<void> | void,
  ms = SIM_DEADLINE_MS,
): Promise<ToolRun> {
  const fail = (message: string): ToolRun => ({ content: JSON.stringify({ error: message }), summary: message, isError: true });
  let out;
  try {
    // The deadline also goes into runIntent so the work itself stops (no new branch or fetch), not just our wait.
    out = await withDeadline(runIntent(call.input, deps, Date.now() + ms), ms, "simulate_paths");
  } catch (err) {
    if (err instanceof UpstreamError) return fail(err.message);
    console.error("[sim] simulate_paths failed:", err);
    return fail("internal error");
  }
  if ("error" in out) return fail(out.error);
  await emitResult({ type: "sim_result", id: call.id, intent: out.intent, branches: out.branches });
  const failed = out.branches.filter((b) => b.error).length;
  return {
    content: JSON.stringify({ branches: out.branches.map(compact) }),
    summary: `${out.branches.length} path${out.branches.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`,
    isError: false,
  };
}
