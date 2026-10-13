import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { OrderIntent } from "../../shared/intel.js";
import type { Candle } from "../../shared/types.js";
import { DeskError } from "../desk/service.js";
import { makeService } from "../desk/testkit.js";
import type { Conversation, LLMProvider, StepResult, ToolSpec } from "../llm/provider.js";
import * as copilot from "./copilot.js";
import { confirmOrder, OrderError, parseOrder, previewOrder, resolveOrder, type CopilotDeps, type OrderMarket } from "./copilot.js";
import type { LlmCacheStore, LlmDeps } from "./llm.js";

const DAY = 86_400_000;

/** Scripted provider: one `emit` input (or text) per step; records systems, prompts and offered tools. */
class EmitProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = false;
  readonly model = "fake-strong";
  systems: string[] = [];
  prompts: string[] = [];
  tools: ToolSpec[][] = [];
  constructor(private readonly replies: unknown[]) {}
  start(system: string, _h: unknown[], question: string): Conversation {
    this.systems.push(system);
    this.prompts.push(question);
    const self = this;
    return {
      async step(tools): Promise<StepResult> {
        self.tools.push(tools);
        const input = self.replies.shift();
        const toolCalls = input === undefined ? [] : [{ id: "t1", name: "emit", input }];
        return { stop: toolCalls.length ? "tool_use" : "end", toolCalls, usage: { input_tokens: 10, output_tokens: 5 } };
      },
      addToolResults() {},
    };
  }
}

class MemCache implements LlmCacheStore {
  rows = new Map<string, unknown>();
  async cacheGet(k: string, v: string) {
    return this.rows.get(`${k}|${v}`) ?? null;
  }
  async cachePut(k: string, v: string, out: unknown) {
    this.rows.set(`${k}|${v}`, out);
  }
  async callsSince() {
    return 0;
  }
}

const llm = (provider: LLMProvider | null): LlmDeps => ({ makeProvider: () => provider, cache: new MemCache(), now: () => new Date("2026-10-05T12:00:00Z"), dailyCap: 100 });

// ─── resolveOrder ───

const NOW = new Date("2026-10-13T12:00:00Z");
const TODAY = Date.UTC(2026, 9, 13);

/** 20 complete daily candles (TR 200 each, yesterday's 300) plus today's open one with an extreme low that must be ignored. */
function dailies(): Candle[] {
  const out: Candle[] = [];
  for (let i = 20; i >= 1; i--) {
    const t = TODAY - i * DAY;
    const y = i === 1;
    out.push({ t, T: t + DAY - 1, o: 4000, h: y ? 4150 : 4100, l: y ? 3850 : 3900, c: 4000, v: 1 });
  }
  out.push({ t: TODAY, T: TODAY + DAY - 1, o: 4000, h: 4500, l: 3000, c: 4000, v: 1 });
  return out;
}

const market = (over: Partial<OrderMarket> = {}): OrderMarket => ({ coin: "ETH", markPx: 4000, maxLeverage: 25, szDecimals: 4, equityUsd: 10_000, daily: dailies(), now: NOW, ...over });
const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({ asset: "ETH", side: "long", leverage: 5, size: { usd: 1000 }, entry: { type: "market" }, stop: { type: "price", px: 3800 }, ...over });

function ok(r: ReturnType<typeof resolveOrder>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r;
}

describe("resolveOrder", () => {
  test("price stop: size, notional, risk in USD and % of book", () => {
    const r = ok(resolveOrder(intent(), market()));
    expect(r.resolved).toMatchObject({ entryPx: 4000, stopPx: 3800, size: 0.25, notionalUsd: 1000, riskUsd: 50, riskPct: 0.5 });
    expect(r.notes.join("\n")).toContain("stop = 3,800 as given (−5.00% from entry)");
  });

  test("pct stop sits on the loss side of entry (short above)", () => {
    expect(ok(resolveOrder(intent({ side: "short", stop: { type: "pct", pct: 5 } }), market())).resolved.stopPx).toBe(4200);
    expect(ok(resolveOrder(intent({ stop: { type: "pct", pct: 2.5 } }), market())).resolved.stopPx).toBe(3900);
  });

  test("pct stop on a limit entry is measured from the limit price", () => {
    const r = ok(resolveOrder(intent({ entry: { type: "limit", px: 3950 }, stop: { type: "pct", pct: 2 } }), market()));
    expect(r.resolved).toMatchObject({ entryPx: 3950, stopPx: 3871 });
  });

  test("prev_day_low / prev_day_high come from yesterday's complete UTC candle, not today's", () => {
    const low = ok(resolveOrder(intent({ stop: { type: "prev_day_low" } }), market()));
    expect(low.resolved.stopPx).toBe(3850);
    expect(low.notes.join("\n")).toContain("stop = yesterday's low 3,850 (2026-10-12 UTC candle)");
    expect(low.warnings).toEqual([]);
    expect(ok(resolveOrder(intent({ side: "short", stop: { type: "prev_day_high" } }), market())).resolved.stopPx).toBe(4150);
  });

  test("prev_day falls back to the last complete candle with a warning", () => {
    const r = ok(resolveOrder(intent({ stop: { type: "prev_day_low" } }), market({ daily: dailies().filter((c) => c.t < TODAY - DAY) })));
    expect(r.resolved.stopPx).toBe(3900);
    expect(r.warnings.join()).toContain("2026-10-11 candle was used");
  });

  test("atr_mult uses ATR14 of complete daily candles", () => {
    // ATR14 = (13 × 200 + 300) / 14 = 207.142857…; 2 × ATR below 4000 = 3585.71 → 5 significant figures
    const r = ok(resolveOrder(intent({ stop: { type: "atr_mult", mult: 2 } }), market()));
    expect(r.resolved.stopPx).toBe(3585.7);
    expect(r.notes.join("\n")).toContain("2 × ATR14 (1d) 207.143");
    const short = resolveOrder(intent({ stop: { type: "atr_mult", mult: 2 } }), market({ daily: dailies().slice(-5) }));
    expect(short).toMatchObject({ ok: false, field: "stop" });
  });

  test("a stop on the wrong side is rejected", () => {
    expect(resolveOrder(intent({ stop: { type: "price", px: 4100 } }), market())).toMatchObject({ ok: false, field: "stop" });
    expect(resolveOrder(intent({ side: "short", stop: { type: "prev_day_low" } }), market())).toMatchObject({ ok: false, field: "stop", error: expect.stringContaining("wrong side") });
    expect(resolveOrder(intent({ entry: { type: "limit", px: 3700 } }), market())).toMatchObject({ ok: false, field: "stop" });
  });

  test("pctBook sizes against Desk equity as notional", () => {
    const r = ok(resolveOrder(intent({ size: { pctBook: 10 } }), market({ equityUsd: 25_000 })));
    expect(r.resolved).toMatchObject({ notionalUsd: 2500, size: 0.625, riskUsd: 125, riskPct: 0.5 });
    expect(resolveOrder(intent({ size: { pctBook: 10 } }), market({ equityUsd: 0 }))).toMatchObject({ ok: false, field: "size" });
  });

  test("liquidation price, both sides (mmr = 1 / (2 · maxLeverage))", () => {
    // mmr = 1/50 = 0.02; long 4000 × (1 − 0.2 + 0.02) = 3280; short 4000 × (1 + 0.2 − 0.02) = 4720
    expect(ok(resolveOrder(intent(), market())).resolved.liqPx).toBe(3280);
    expect(ok(resolveOrder(intent({ side: "short", stop: { type: "price", px: 4200 } }), market())).resolved.liqPx).toBe(4720);
  });

  test("leverage above the coin maximum is clamped with a warning", () => {
    const r = ok(resolveOrder(intent({ leverage: 40, stop: { type: "price", px: 3950 } }), market()));
    expect(r.leverage).toBe(25);
    expect(r.warnings.join()).toContain("leverage 40x clamped to the ETH maximum of 25x");
    // 4000 × (1 − 1/25 + 1/50) = 3920
    expect(r.resolved.liqPx).toBe(3920);
  });

  test("warns when liquidation comes before the stop", () => {
    const r = ok(resolveOrder(intent({ leverage: 20, stop: { type: "price", px: 3700 } }), market()));
    expect(r.warnings.join()).toContain("reached before the stop");
  });
});

// ─── parseOrder ───

const GOOD = { intent: { asset: "ETH", side: "long", leverage: 3, size: { usd: 1500 }, entry: { type: "market" }, stop: { type: "prev_day_low" } }, assumptions: ["entry not given: market"] };

describe("parseOrder", () => {
  test("strong tier, emit only, zod-validated intent with assumptions", async () => {
    const p = new EmitProvider([GOOD]);
    const r = await parseOrder({ llm: llm(p) }, "long eth 3x 1.5k, stop under yesterday's low");
    expect(r).toMatchObject({ ok: true, intent: GOOD.intent, assumptions: GOOD.assumptions, trace: { tier: "strong", model: "fake-strong", promptVersion: copilot.COPILOT_PROMPT_VERSION } });
    expect(p.tools.flat().map((t) => t.name)).toEqual(["emit"]);
    expect(p.prompts[0]).toContain("long eth 3x 1.5k");
    expect(p.systems[0]).not.toMatch(/previewHash|confirm\w*Order|submit/i);
  });

  test("rejects invalid output after the retry, including smuggled fields", async () => {
    const smuggled = { ...GOOD, intent: { ...GOOD.intent, previewHash: "abcdefgh12345678" } };
    const badStop = { ...GOOD, intent: { ...GOOD.intent, stop: { type: "price", px: -1 } } };
    const p = new EmitProvider([smuggled, badStop]);
    const r = await parseOrder({ llm: llm(p) }, "long eth");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid output after retry");
    expect(p.tools).toHaveLength(2);
  });

  test("intent null → the model's problem; over-long text never reaches the model", async () => {
    const r = await parseOrder({ llm: llm(new EmitProvider([{ intent: null, assumptions: [], problem: "no asset given" }])) }, "go long 3x");
    expect(r).toMatchObject({ ok: false, error: "no asset given" });
    const p = new EmitProvider([GOOD]);
    expect(await parseOrder({ llm: llm(p) }, "x".repeat(501))).toMatchObject({ ok: false });
    expect(p.prompts).toHaveLength(0);
  });
});

// ─── preview → confirm on the paper Desk ───

function deps(provider: LLMProvider | null = null) {
  const kit = makeService();
  const t0 = Date.UTC(2026, 9, 5);
  kit.data.candleMap.set(
    "ETH",
    Array.from({ length: 20 }, (_, i) => {
      const t = t0 - (20 - i) * DAY;
      return { t, T: t + DAY - 1, o: 4000, h: 4100, l: 3880, c: 4000, v: 1 };
    }),
  );
  const d: CopilotDeps = { llm: llm(provider), desk: kit.service };
  return { ...kit, deps: d };
}

const ETH_ORDER: OrderIntent = { asset: "eth", side: "long", leverage: 3, size: { usd: 800 }, entry: { type: "market" }, stop: { type: "pct", pct: 5 } };
const httpStatus = (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e) => (e instanceof DeskError || e instanceof OrderError ? e.status : -1),
  );

describe("previewOrder / confirmOrder", () => {
  test("happy path: preview (governor verdict, paper venue) then confirm executes once", async () => {
    const { deps: d, store } = deps();
    const pv = await previewOrder(d, { intent: ETH_ORDER });
    expect(pv).toMatchObject({ venue: "paper", markPx: 4000, resolved: { entryPx: 4000, stopPx: 3800, notionalUsd: 800, riskUsd: 40, riskPct: 0.4, liqPx: 2766.7 }, verdict: { decision: "approve", approved: true } });
    expect(pv.notes!.join("\n")).toContain("stop = 5% below entry: 3,800");
    expect(await store.listFills(10)).toHaveLength(0);

    const res = await confirmOrder(d, { intent: ETH_ORDER, previewHash: pv.previewHash });
    expect(res).toMatchObject({ status: "executed", verdict: { approved: true } });
    expect(await store.listFills(10)).toHaveLength(1);
    expect((await store.getProposal(res.proposalId))!.decidedBy).toBe("operator:copilot");
  });

  test("text preview: parsed intent, assumptions and trace; prev-day stop from candles", async () => {
    const p = new EmitProvider([{ ...GOOD, intent: { ...GOOD.intent, size: { usd: 800 } } }]);
    const { deps: d } = deps(p);
    const pv = await previewOrder(d, { text: "long eth 3x 800, stop under yesterday's low" });
    expect(pv.resolved.stopPx).toBe(3880);
    expect(pv.assumptions).toEqual(GOOD.assumptions);
    expect(pv.trace?.model).toBe("fake-strong");
  });

  test("text preview without a provider → 503", async () => {
    const { deps: d } = deps(null);
    expect(await httpStatus(previewOrder(d, { text: "long eth" }))).toBe(503);
  });

  test("a market order confirms at the previewed mark while the live mark is within 0.5%", async () => {
    const { deps: d, data } = deps();
    const pv = await previewOrder(d, { intent: ETH_ORDER });
    data.setMark("ETH", 4010);
    expect((await confirmOrder(d, { intent: ETH_ORDER, previewHash: pv.previewHash })).status).toBe("executed");
  });

  test("confirm without a preview → 409, nothing fills", async () => {
    const { deps: d, store } = deps();
    expect(await httpStatus(confirmOrder(d, { intent: ETH_ORDER, previewHash: "a".repeat(64) }))).toBe(409);
    expect(await store.listFills(10)).toHaveLength(0);
  });

  test("double confirm → exactly one executes", async () => {
    const { deps: d, store } = deps();
    const pv = await previewOrder(d, { intent: ETH_ORDER });
    const out = await Promise.allSettled([confirmOrder(d, { intent: ETH_ORDER, previewHash: pv.previewHash }), confirmOrder(d, { intent: ETH_ORDER, previewHash: pv.previewHash })]);
    expect(out.filter((r) => r.status === "fulfilled" && r.value.status === "executed")).toHaveLength(1);
    expect(out.filter((r) => r.status === "rejected" && r.reason instanceof DeskError && r.reason.status === 409)).toHaveLength(1);
    expect(await store.listFills(10)).toHaveLength(1);
  });

  test("confirm with a changed intent → 409", async () => {
    const { deps: d } = deps();
    const pv = await previewOrder(d, { intent: ETH_ORDER });
    expect(await httpStatus(confirmOrder(d, { intent: { ...ETH_ORDER, size: { usd: 900 } }, previewHash: pv.previewHash }))).toBe(409);
  });

  test("unknown coin → 400 on intent.asset", async () => {
    const { deps: d } = deps();
    const err = await previewOrder(d, { intent: { ...ETH_ORDER, asset: "NOPE" } }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect(err).toMatchObject({ status: 400, field: "intent.asset" });
  });
});

describe("the LLM path cannot reach execution", () => {
  test("only confirmOrder calls submitOperatorOrder", () => {
    const src = readFileSync(new URL("./copilot.ts", import.meta.url), "utf8");
    expect(src.match(/submitOperatorOrder\(/g)).toHaveLength(1);
    expect(confirmOrder.toString()).toContain("submitOperatorOrder(");
    for (const [name, value] of Object.entries(copilot)) {
      if (typeof value === "function" && name !== "confirmOrder") expect(value.toString()).not.toContain("submitOperatorOrder");
    }
  });
});
