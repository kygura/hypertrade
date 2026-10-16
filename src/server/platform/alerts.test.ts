import { describe, expect, test } from "bun:test";
import type { Opportunity } from "../../shared/platform.js";
import { createAlerts } from "./alerts.js";
import { Bus } from "./bus.js";

const opp = (over: Partial<Opportunity> = {}) => ({ id: "a", coin: "SOL", direction: "long", setupKind: "k", status: "ready", score: 5, netEdgeBps: 40, edgeBasis: "unvalidated", ...over }) as Opportunity;

function setup(age: { v: number | null } = { v: 1 }, clock = { t: 0 }) {
  const sent: { title: string; body: string }[] = [];
  const bus = new Bus();
  const a = createAlerts({ notifier: { send: async (m) => (sent.push(m), ["telegram"]) }, wsAgeSec: () => age.v, appUrl: "https://app.example.com/", pushScore: 3, now: () => clock.t });
  a.subscribe(bus);
  return { sent, bus, a, age, clock };
}

describe("ready push", () => {
  test("fires once per opportunity at or above the score, linking to the cockpit", () => {
    const { sent, bus } = setup();
    const pub = (o: Opportunity, change: "status" | "updated" = "status") => bus.publish("opportunity", { opportunity: o, change });
    pub(opp({ score: 2 }));
    pub(opp({ status: "calculated" }));
    pub(opp(), "updated");
    pub(opp());
    pub(opp());
    pub(opp({ id: "b" }));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toEndWith("https://app.example.com/");
    expect(sent[0]!.body).not.toContain("terminal");
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
