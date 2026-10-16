import { describe, expect, test } from "bun:test";
import { addManualCatalyst, catalystAlerts, deleteManualCatalyst } from "./catalysts.js";
import { mapperDeps, position } from "./fixtures/mapper-deps.js";
import type { NewEvent } from "./store.js";

const T0 = Date.parse("2026-10-13T12:00:00Z");
const H = 3_600_000;
const at = (h: number) => new Date(T0 + h * H).toISOString();

const macro = (h: number): NewEvent => ({
  key: `calendar:cpi:${h}`,
  type: "macro",
  title: "US CPI release",
  summary: null,
  entities: ["USD", "DXY", "NASDAQ"],
  assets: [],
  magnitude: "high",
  sources: [{ label: "BLS CPI release schedule", url: "https://www.bls.gov/schedule/news_release/cpi.htm" }],
  origin: "calendar",
  firstSeen: at(-48),
  scheduledAt: at(h),
  catalyst: null,
  tag: "observed",
});

function setup(pushMateriality = 0.2) {
  const clock = { now: new Date(T0) };
  const deps = mapperDeps({ provider: null, clock, pushMateriality, positions: [position("SOL", "long", 5_000), position("BTC", "long", 5_000)], watched: ["HYPE"] });
  return { clock, deps, store: deps.store };
}

describe("catalystAlerts", () => {
  test("T−24h and T−1h windows for exposed assets, routed like the mapper, dedupe per window", async () => {
    const { clock, deps, store } = setup();
    const unlock = await addManualCatalyst(store, { title: "SOL unlock", assets: ["SOL"], scheduledAt: at(20), type: "unlock", url: "https://example.com/unlock" }, clock.now);
    const soon = await addManualCatalyst(store, { title: "HYPE upgrade", assets: ["HYPE"], scheduledAt: at(0.5), type: "upgrade" }, clock.now);
    await addManualCatalyst(store, { title: "Too far", assets: ["SOL"], scheduledAt: at(30), type: "other" }, clock.now);
    await addManualCatalyst(store, { title: "Unrelated", assets: ["DOGE"], scheduledAt: at(2), type: "other" }, clock.now);
    const [cpi] = await store.upsertEvents([macro(5), { ...macro(-1), key: "calendar:past" }]);

    const r = await catalystAlerts(deps, clock.now);
    const rows = r.alerts.map((a) => [a.title, a.asset, a.window, a.hops, a.route]);
    expect(rows).toEqual([
      ["HYPE upgrade", "HYPE", "1h", 0, "batch"], // 0.6 × 1 × 0.05 watch floor
      ["US CPI release", "BTC", "24h", 1, "batch"], // 1 × 0.3 × 0.5
      ["SOL unlock", "SOL", "24h", 0, "push"], // 0.6 × 1 × 0.5 ≥ 0.2
    ]);
    const byTitle = Object.fromEntries(r.alerts.map((a) => [a.title, a]));
    expect(byTitle["SOL unlock"]!.line).toEqual({
      tag: "observed",
      text: "SOL unlock at 2026-10-14 08:00 UTC (in 20h). Long SOL; exposed via SOL named directly.",
      source: { label: "example.com", url: "https://example.com/unlock" },
      ts: clock.now.toISOString(),
    });
    expect(byTitle["SOL unlock"]!.ref).toBe(unlock.id);
    expect(byTitle["HYPE upgrade"]!.line).toEqual({ tag: "hypothesis", text: "HYPE upgrade at 2026-10-13 12:30 UTC (in 30m). Watching HYPE; exposed via HYPE named directly." });
    expect(byTitle["HYPE upgrade"]!.ref).toBe(soon.id);
    expect(byTitle["US CPI release"]).toMatchObject({ ref: cpi!.id, edgeType: "macro_beta", pathWeight: 0.3, materiality: expect.closeTo(1 * 0.3 * 0.5, 9), pricedIn: null });
    expect(byTitle["US CPI release"]!.line.tag).toBe("observed");

    expect(deps.notifier.sent.map((s) => s.title)).toEqual(["T−24h: SOL unlock"]);
    expect(deps.notifier.sent[0]!.body).toContain("https://app.example.com/terminal?review=1");

    // Same windows again: nothing new.
    clock.now = new Date(T0 + 10 * 60_000);
    expect((await catalystAlerts(deps, clock.now)).alerts).toEqual([]);
    expect(deps.notifier.sent).toHaveLength(1);

    // The unlock enters its last hour (T−1h fires once); the event at +30 h is now inside 24 h.
    clock.now = new Date(T0 + 19.5 * H);
    const late = await catalystAlerts(deps, clock.now);
    expect(late.alerts.map((a) => [a.title, a.window])).toEqual([
      ["SOL unlock", "1h"],
      ["Too far", "24h"],
    ]);
    expect((await catalystAlerts(deps, clock.now)).alerts).toEqual([]);
  });

  test("a pushed catalyst carries 👍/👎 for each stored alert, named by asset when several share the message", async () => {
    const { clock, deps, store } = setup();
    await addManualCatalyst(store, { title: "SOL+BTC unlock", assets: ["SOL", "BTC"], scheduledAt: at(20), type: "unlock" }, clock.now);
    const [sol, btc] = (await catalystAlerts(deps, clock.now)).alerts.filter((a) => a.route === "push");
    expect(deps.notifier.sent[0]!.actions).toEqual([
      { label: "👍 SOL", data: `fb:${sol!.id}:1` },
      { label: "👎 SOL", data: `fb:${sol!.id}:-1` },
      { label: "👍 BTC", data: `fb:${btc!.id}:1` },
      { label: "👎 BTC", data: `fb:${btc!.id}:-1` },
    ]);
  });

  test("feedback dampening batches a catalyst push, same as the mapper", async () => {
    const { clock, deps, store } = setup();
    for (const i of [1, 2, 3, 4, 5]) {
      const a = await store.insertAlert({
        kind: "catalyst", ref: `old-${i}`, window: "24h", asset: "SOL", title: "t", eventType: "unlock", line: { tag: "hypothesis", text: "x" },
        path: [], edgeType: null, hops: 0, pathWeight: 1, sources: [], materiality: 0.3, pricedIn: null, route: "push",
      });
      await store.setAlertFeedback(a!.id, -1);
    }
    await addManualCatalyst(store, { title: "SOL unlock", assets: ["SOL"], scheduledAt: at(20), type: "unlock" }, clock.now);
    const r = await catalystAlerts(deps, clock.now);
    expect(r.alerts.map((a) => [a.asset, a.route])).toEqual([["SOL", "batch"]]);
    expect(deps.notifier.sent).toHaveLength(0);
  });

  test("estimated (hypothesis) events stay hypotheses even with a URL; nothing scheduled → no context load", async () => {
    const { clock, deps, store } = setup();
    let loads = 0;
    const exposure = deps.exposure;
    deps.exposure = async () => (loads++, exposure());
    expect(await catalystAlerts(deps, clock.now)).toEqual({ alerts: [] });
    expect(loads).toBe(0);
    await store.upsertEvents([{ ...macro(3), tag: "hypothesis" }]);
    const r = await catalystAlerts(deps, clock.now);
    expect(r.alerts[0]!.line.tag).toBe("hypothesis");
  });
});

describe("manual catalysts", () => {
  test("add stores a manual event (observed with a URL, hypothesis without); delete refuses non-manual", async () => {
    const { clock, store } = setup();
    const e = await addManualCatalyst(store, { title: "ETH upgrade", assets: ["ETH"], scheduledAt: "2026-10-20T14:00:00+02:00", type: "upgrade", size: "major", directionHypothesis: "unclear" }, clock.now);
    expect(e).toMatchObject({
      origin: "manual",
      type: "upgrade",
      assets: ["ETH"],
      entities: ["ETH"],
      scheduledAt: "2026-10-20T12:00:00.000Z",
      catalyst: { size: "major", directionHypothesis: "unclear" },
      sources: [{ label: "manual" }],
      tag: "hypothesis",
    });
    const [cal] = await store.upsertEvents([macro(5)]);
    expect(await deleteManualCatalyst(store, cal!.id)).toBe("not_manual");
    expect(await deleteManualCatalyst(store, "nope")).toBe("not_found");
    expect(await deleteManualCatalyst(store, e.id)).toBe("deleted");
    expect(await store.getEvent(e.id)).toBeNull();
  });
});
