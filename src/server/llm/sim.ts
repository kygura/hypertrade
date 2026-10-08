import { DISCLAIMER, FORECAST_RULE, HARD_RULE, HEDGE_VOCABULARY } from "./system.js";
import { toolCatalog, withDeadline, type ToolRun } from "./tools.js";
import type { ToolSpec } from "./provider.js";
import { getCtxs } from "../routes/hl.js";
import { runIntent, type IntentDeps } from "../sim/intent.js";
import { realDeps } from "../sim/run.js";
import type { SimBranchOutcome, SimIntent } from "../../shared/intent.js";

// Sim mode of the analyst (SPEC.md "Paths", decisions 2/5/7/9). The JSON schema
// below is only a hint for the model; SimIntentSchema (zod, inside runIntent) is
// the authority.

export const SIM_DEADLINE_MS = 40_000;

const allocation = {
  type: "object",
  additionalProperties: false,
  required: ["coin", "weightPct"],
  properties: {
    coin: { type: "string", description: "Hyperliquid coin symbol (BTC, ETH, SOL, ...) or USDC/USDT for cash." },
    weightPct: { type: "number", description: "Percent of starting capital (weights should sum to 100). For a perp leg this is the margin put up." },
    side: { type: "string", enum: ["long", "short"], description: "Default long. short makes it a perp leg. Stablecoins cannot be short." },
    leverage: { type: "number", minimum: 1, maximum: 50, description: "Default 1 (spot). Above 1 makes it a perp leg: notional = margin x leverage. Stablecoins cannot be levered." },
  },
};

export const SIM_TOOL_SPEC: ToolSpec = {
  name: "simulate_paths",
  description:
    "Run 1-4 historical portfolio simulations (branches) and compare them. Spot or perp legs, optional rebalancing, DCA and Monte Carlo scenario. Results are historical, ignore funding and fees. Returns per-branch stats; the full curves are shown to the user separately.",
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
                initialCapitalUsd: { type: "number", description: "Default 10000 when the user states no amount." },
                allocations: { type: "array", items: allocation },
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
                      coin: { type: "string" },
                      amountUsd: { type: "number", exclusiveMinimum: 0 },
                      every: { type: "string", enum: ["weekly", "monthly"] },
                    },
                  },
                },
                scenario: {
                  type: "object",
                  additionalProperties: false,
                  required: ["horizonDays", "assumptions", "paths"],
                  description: "Forward Monte Carlo fan; only for unlevered long-only branches (dropped otherwise).",
                  properties: {
                    horizonDays: { type: "integer", minimum: 1 },
                    paths: { type: "integer", minimum: 1 },
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

${HARD_RULE}

${HEDGE_VOCABULARY}

${FORECAST_RULE}

Simulation rules:
- Always call simulate_paths before quoting any number. Never compute or guess results yourself.
- Results are historical simulation, not advice and not a forecast. Say so, and relay each branch's warnings.
- When the idea is open-ended ("hedge my ETH"), run 2-3 contrasting branches in one call (for example unhedged vs 50% hedge vs full hedge).
- Ask a one-line clarifying question only when no reasonable default exists; otherwise assume and proceed.
- There is no holdings source: default to a $10,000 stack unless the user states an amount, and turn implicit holdings ("my ETH") into explicit allocations. Put every inference (stack size, start date, coins, DCA funding) in "assumptions".
- Weights are percent of starting capital and should sum to 100. A perp leg's weight is its margin; leverage multiplies the notional. DCA is self-financed from the USDC sleeve, so give USDC a weight large enough to fund it.
- startDate is an ISO date. The question carries [current time ...]; resolve "since January" or "last year" against it. A start earlier than a coin's first candle is moved forward and reported in warnings.
- Earlier assistant turns may end with a "[paths]" trailer holding each path's normalized config. For follow-ups ("same but 5x", "without the DCA"), modify those configs instead of re-guessing.
- Perp legs ignore funding and fees and liquidate on daily lows/highs; the tool's warnings say so. Report them.
- Be dense and specific: short paragraphs or tight bullets, numbers with units.
- End every answer containing any market read with this line, verbatim:
  ${DISCLAIMER}

Tools:
${tools}
- simulate_paths — historical portfolio simulation (1-4 branches)`;
}

/** Real deps for sim mode; the HL max-leverage map comes from the cached universe fetch, undefined on failure. */
export async function realSimDeps(): Promise<IntentDeps> {
  let max: Map<string, number | undefined> | undefined;
  try {
    const { ctxs } = await getCtxs();
    max = new Map(ctxs.map((c) => [c.name.toUpperCase(), c.maxLeverage]));
  } catch {
    // HL unreachable: schema cap (50x) applies
  }
  return { ...realDeps, maxLeverage: (coin) => max?.get(coin.toUpperCase()) };
}

const round = (n: number) => Math.round(n * 100) / 100;

function compact(b: SimBranchOutcome) {
  const s = b.result?.stats;
  const cap = b.config.initialCapitalUsd;
  return {
    name: b.name,
    finalValue: s && round(s.finalValue),
    totalReturnPct: s && cap > 0 ? round((s.finalValue / cap - 1) * 100) : undefined,
    cagrPct: s && round(s.cagrPct),
    maxDrawdownPct: s && round(s.maxDrawdownPct),
    vsBtcPct: s && round(s.vsBtcPct),
    startDate: b.config.startDate,
    warnings: b.warnings,
    error: b.error,
  };
}

/** Runs one simulate_paths call: emits sim_result (before the caller emits tool_result) and returns the compact tool content. */
export async function runSimTool(
  call: { id: string; input: unknown },
  deps: IntentDeps,
  emitResult: (e: { type: "sim_result"; id: string; intent: SimIntent; branches: SimBranchOutcome[] }) => Promise<void> | void,
): Promise<ToolRun> {
  const fail = (message: string): ToolRun => ({ content: JSON.stringify({ error: message }), summary: message, isError: true });
  let out;
  try {
    out = await withDeadline(runIntent(call.input, deps), SIM_DEADLINE_MS, "simulate_paths");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
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
