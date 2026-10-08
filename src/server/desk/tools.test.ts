import { describe, expect, test } from "bun:test";
import { ACTION_TOOLS, atr, ema, MAX_PROPOSALS_PER_RUN, READ_TOOLS, toolByName, type ToolContext } from "./tools.js";
import { ctx, hourly, makeService } from "./testkit.js";
import type { DeskEvent } from "./types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-05T12:00:00Z");

function context(kit = makeService()) {
  const events: DeskEvent[] = [];
  const c: ToolContext = { service: kit.service, runId: null, agent: "pm", emit: (e) => events.push(e), budget: { proposals: 0, alerts: 0 } };
  return { ...kit, c, events };
}

const run = (name: string, input: unknown, c: ToolContext) => toolByName(name)!.run(input, c);

describe("indicators", () => {
  test("ema seeds with the simple mean, atr averages true ranges", () => {
    expect(ema([1, 2, 3], 3)).toBe(2);
    expect(ema([1, 2, 3, 4], 3)).toBe(3);
    expect(ema([1, 2], 3)).toBeNull();
    const bars = [
      { h: 11, l: 9, c: 10 },
      { h: 12, l: 10, c: 11 },
      { h: 15, l: 11, c: 14 },
    ];
    expect(atr(bars, 2)).toBe(3); // TRs 2 and 4
  });
});

describe("read tools", () => {
  test("flow_diagnostics resolves the coin's case and reads candles, funding and OI", async () => {
    const { c, data } = context(makeService({ ctxs: [ctx("kPEPE", 0.01)] }));
    const prices = Array.from({ length: 150 }, (_, i) => 0.01 * (1 + (i > 75 ? (i - 75) * 0.001 : 0)) * (1 + 0.002 * Math.sin(i)));
    data.candleMap.set("kPEPE", hourly(prices, NOW));
    data.seriesMap.set("hl.oi.kPEPE", [
      { t: NOW - 76 * HOUR, v: 1e6 },
      { t: NOW - HOUR, v: 1.1e6 },
    ]);
    const r = await run("flow_diagnostics", { coin: "KPEPE" }, c);
    expect(r.isError).toBe(false);
    const d = JSON.parse(r.content);
    expect(d.coin).toBe("kPEPE");
    expect(d.oiChangePct).toBeCloseTo(10, 5);
  });

  test("unknown coins and bad input come back as tool errors", async () => {
    const { c } = context();
    expect((await run("flow_diagnostics", { coin: "NOPE" }, c)).summary).toContain("not a listed");
    expect((await run("flow_diagnostics", { coin: "BTC", window_hours: 1 }, c)).summary).toBe("invalid input");
  });

  test("macro_dashboard reports 1m/3m changes and says when nothing is collected", async () => {
    const { c, data, service } = context();
    expect((await run("macro_dashboard", {}, c)).isError).toBe(true);
    const now = service.now().getTime();
    data.seriesMap.set("fred.DGS10", [
      { t: now - 95 * DAY, v: 4.0 },
      { t: now - 31 * DAY, v: 4.2 },
      { t: now - DAY, v: 4.5 },
    ]);
    const r = JSON.parse((await run("macro_dashboard", {}, c)).content);
    const ten = r.series.find((s: { id: string }) => s.id === "fred.DGS10");
    expect(ten).toMatchObject({ latest: 4.5, chg1m: 0.3, chg3m: 0.5 });
  });

  test("price_structure reports ranges, EMAs and ATR", async () => {
    const { c, data, service } = context();
    const now = service.now().getTime();
    const daily = Array.from({ length: 250 }, (_, i) => {
      const t = now - (250 - i) * DAY;
      const p = 3000 + i * 4;
      return { t, T: t + DAY - 1, o: p - 2, h: p + 30, l: p - 30, c: p, v: 1 };
    });
    data.candleMap.set("ETH", daily);
    const r = JSON.parse((await run("price_structure", { coin: "ETH", interval: "1d" }, c)).content);
    expect(r.ema200.value).toBeGreaterThan(3000);
    expect(r.atr14d.value).toBeCloseTo(60, 0);
    expect(r.bars).toHaveLength(12);
  });

  test("cycle_regime explains itself when hl-cycles is not connected", async () => {
    const { c } = context();
    expect((await run("cycle_regime", {}, c)).summary).toContain("DESK_CYCLES_URL");
  });

  test("every read tool has a unique name and an object schema", () => {
    const names = READ_TOOLS.map((t) => t.spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of [...READ_TOOLS, ...ACTION_TOOLS]) expect(t.spec.input_schema.type).toBe("object");
  });
});

describe("action tools", () => {
  const trade = {
    coin: "ETH",
    side: "long",
    setup: "test setup",
    thesis: "A long for the budget test, long enough to pass validation.",
    horizon: "swing",
    confidence: "medium",
    stop: 3800,
    target: 4500,
    riskPct: 0.5,
    invalidation: "close under the stop",
    evidence: [
      { source: "a", point: "one" },
      { source: "b", point: "two" },
    ],
  };

  test("propose_trade validates, emits the outcome, and respects the per-run budget", async () => {
    const { c, events } = context();
    expect((await run("propose_trade", { ...trade, evidence: [] }, c)).summary).toBe("invalid input");
    for (let i = 0; i < MAX_PROPOSALS_PER_RUN; i++) await run("propose_trade", { ...trade, coin: ["ETH", "SOL", "BTC"][i], stop: [3800, 190, 95_000][i], target: [4500, 230, 110_000][i] }, c);
    const over = await run("propose_trade", trade, c);
    expect(over.summary).toContain("budget");
    expect(events.filter((e) => e.type === "proposal")).toHaveLength(MAX_PROPOSALS_PER_RUN);
  });

  test("send_alert goes through the notifier", async () => {
    const { c, notifier } = context();
    await run("send_alert", { level: "warn", title: "Funding extreme", body: "ETH funding at 90% APR" }, c);
    expect(notifier.sent.at(-1)).toMatchObject({ level: "warn", title: "Funding extreme" });
  });
});
