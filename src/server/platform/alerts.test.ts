import { describe, expect, test } from "bun:test";
import type { Opportunity } from "../../shared/platform.js";
import { createAlerts } from "./alerts.js";
import { Bus } from "./bus.js";
import type { OutcomeRow } from "./store.js";

const opp = (over: Partial<Opportunity> = {}) => ({ id: "a", coin: "SOL", direction: "long", setupKind: "k", status: "ready", score: 5, netEdgeBps: 40, edgeBasis: "unvalidated", ...over }) as Opportunity;

function setup(age: { v: number | null } = { v: 1 }, clock = { t: 0 }, rows: OutcomeRow[] = []) {
  const sent: { title: string; body: string }[] = [];
  const bus = new Bus();
  const a = createAlerts({ store: { outcomeRows: async () => rows }, notifier: { send: async (m) => (sent.push(m), ["telegram"]) }, wsAgeSec: () => age.v, appUrl: "https://app.example.com/", pushScore: 3, now: () => clock.t });
  a.subscribe(bus);
  return { sent, bus, a, age, clock };
}

describe("ready push", () => {
  test("fires once per opportunity at or above the score, linking to the cockpit", async () => {
    const { sent, bus } = setup();
    const pub = (o: Opportunity, change: "status" | "updated" = "status") => bus.publish("opportunity", { opportunity: o, change });
    pub(opp({ score: 2 }));
    pub(opp({ status: "calculated" }));
    pub(opp(), "updated");
    pub(opp());
    pub(opp());
    pub(opp({ id: "b" }));
    await Bun.sleep(0);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toEndWith("https://app.example.com/");
    expect(sent[0]!.body).not.toContain("terminal");
  });
});

describe("ready push evidence line", () => {
  const out = (i: number, net: number, h = "24h"): OutcomeRow => ({ opportunityId: `o${i}`, setupKind: "k", regime: "trend", liquidityTier: 1, horizon: h, createdAtMs: i * 2 * 86_400_000, grossReturn: net, netReturn: net, hasCosts: true });
  test("seeded ledger: n, clusters, mean and interval at 24h", async () => {
    const { sent, bus } = setup(undefined, undefined, [0.01, 0.02, 0.03, 0.04, 0.05].map((x, i) => out(i, x)));
    bus.publish("opportunity", { opportunity: opp(), change: "status" });
    await Bun.sleep(0);
    expect(sent[0]!.body).toContain("\nledger 24h: n 5 \u00b7 5 clusters \u00b7 +3.00% (+1.0\u2026+5.0) \u00b7 edge unvalidated");
  });
  test("empty ledger: n 0", async () => {
    const { sent, bus } = setup();
    bus.publish("opportunity", { opportunity: opp(), change: "status" });
    await Bun.sleep(0);
    expect(sent[0]!.body).toContain("ledger 24h: n 0 \u00b7 0 clusters \u00b7 edge unvalidated");
  });
});

describe("ws silence", () => {
  test("silence fires once, recovery fires once", async () => {
    const { sent, a, age } = setup();
    await a.check();
    expect(sent).toHaveLength(0);
    age.v = 31;
    await a.check();
    age.v = 90;
    await a.check();
    expect(sent.map((s) => s.title)).toEqual(["Hyperliquid feed silent"]);
    age.v = 2;
    await a.check();
    expect(sent).toHaveLength(1); // one ok check is not recovery
    await a.check();
    expect(sent.map((s) => s.title)).toEqual(["Hyperliquid feed silent", "Hyperliquid feed recovered"]);
    age.v = null;
    await a.check();
    expect(sent).toHaveLength(2);
  });

  test("never connected: alerts once after 60 s, then recovers", async () => {
    const { sent, a, age, clock } = setup({ v: null });
    clock.t = 59_000;
    await a.check();
    clock.t = 61_000;
    await a.check();
    await a.check();
    expect(sent.map((s) => s.title)).toEqual(["Hyperliquid feed never connected"]);
    age.v = 1;
    await a.check();
    await a.check();
    expect(sent.map((s) => s.title)).toEqual(["Hyperliquid feed never connected", "Hyperliquid feed recovered"]);
  });

  test("a blip resets the recovery streak; silent alerts are 10 min apart", async () => {
    const { sent, a, age, clock } = setup();
    age.v = 40;
    await a.check();
    for (const v of [1, 40, 1]) (age.v = v, await a.check());
    expect(sent).toHaveLength(1); // 1, blip, 1: never two ok in a row
    age.v = 1;
    await a.check();
    expect(sent).toHaveLength(2); // recovered
    clock.t = 5 * 60_000;
    age.v = 40;
    await a.check();
    expect(sent).toHaveLength(2); // inside the cooldown
    clock.t = 11 * 60_000;
    await a.check();
    expect(sent.map((s) => s.title)).toEqual(["Hyperliquid feed silent", "Hyperliquid feed recovered", "Hyperliquid feed silent"]);
  });
});

describe("novel push", () => {
  const e = { id: "2026-02-09:SOL", detectedAt: "2026-02-10T00:30:00.000Z", barDate: "2026-02-09", coin: "SOL", kind: "new_extreme", families: ["funding"], nearSetups: [], marketWide: false, pushed: true, notified: [],
    features: [{ id: "funding_z90", value: 9, histMin: -3, histMax: 8, p1: -2, p99: 3, bars: 400, pctRank: 100 }] } as const;
  test("NOVEL: info alert, once per entry; a send no channel took is retried", async () => {
    const sent: { level: string; title: string; body: string }[] = [];
    let channels = ["telegram"];
    const a = createAlerts({ notifier: { send: async (m) => (sent.push(m), channels) }, wsAgeSec: () => 1 });
    const entry = { ...e, features: [...e.features] } as never;
    channels = [];
    expect(await a.novel(entry)).toEqual([]);
    channels = ["telegram"];
    expect(await a.novel(entry)).toEqual(["telegram"]);
    expect(await a.novel(entry)).toEqual([]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ level: "info", title: "NOVEL: SOL — funding_z90 — no setup covers this" });
    expect(sent[1]!.body).not.toContain("http");
  });
});
