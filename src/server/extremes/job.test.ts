import { describe, expect, test } from "bun:test";
import { EXTREMES_SCORE_VERSION, type ExtremeEvent } from "../../shared/extremes.js";
import type { Alert } from "../desk/notify.js";
import { MemoryPlatformStore } from "../platform/store-memory.js";
import { appliedThresholds, resetResult, withMultiplier } from "./calibrate.js";
import { DEFAULT_EXTREME_THRESHOLDS } from "./detect.js";
import { extremeAlert, runExtremesJob, type Detect, type ExtremesJobDeps } from "./job.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 14, 12);
const iso = (t: number) => new Date(t).toISOString();

const ev = (coin: string, severity: number, over: Partial<ExtremeEvent> = {}): ExtremeEvent => ({
  key: `oi_flush|${coin}|long`, kind: "oi_flush", coin, side: "long", ts: iso(NOW), window: "4h", mark: 10, severity,
  facts: { oiChg: -0.2 }, line: `${coin} OI -20% in 4h`, ...over,
});

/** Store with 3 h of 15-min snapshots for each coin, volume descending in the order given. */
async function storeWith(coins: string[], at = NOW, s = new MemoryPlatformStore()) {
  const rows = coins.flatMap((coin, i) =>
    Array.from({ length: 12 }, (_, k) => ({ coin, ts: iso(at - k * 15 * 60_000), inputs: { mark: 10, oiUsd: 1e6, funding: 1e-5, dayNtlVlm: (coins.length - i) * 1e6 } })),
  );
  await s.insertScanSnapshots(rows);
  return s;
}

function harness(store: MemoryPlatformStore, opts: { fire?: Record<string, ExtremeEvent[]>; wake?: boolean | "throw"; channels?: string[]; env?: Record<string, string>; now?: number } = {}) {
  const sent: Alert[] = [];
  const woken: ExtremeEvent[][] = [];
  const seen: Array<{ coin: string; n: number; btc: number | null; th: unknown }> = [];
  const detect: Detect = ({ coin, points, btc }, th) => (seen.push({ coin, n: points.length, btc: btc?.length ?? null, th }), opts.fire?.[coin] ?? []);
  const deps: ExtremesJobDeps = {
    store, detect, thresholds: () => appliedThresholds(store, () => {}), lookbackMs: 30 * 24 * HOUR,
    wake: async (events) => {
      woken.push(events);
      if (opts.wake === "throw") throw new Error("boom");
      return opts.wake ?? false;
    },
    notifier: { send: async (a) => (sent.push(a), opts.channels ?? ["ntfy"]) },
    appUrl: "https://app.example/",
    now: () => opts.now ?? NOW,
    env: opts.env ?? {},
  };
  return { deps, sent, woken, seen };
}

describe("runExtremesJob", () => {
  test("universe: top N by latest volume plus BTC; each coin's own history, BTC passed as the reference", async () => {
    const store = await storeWith(["ETH", "SOL", "HYPE", "WIF", "BTC"]);
    const h = harness(store, { env: { EXTREMES_TOP: "2" } });
    const r = await runExtremesJob(h.deps);
    expect(h.seen.map((x) => x.coin)).toEqual(["ETH", "SOL", "BTC"]);
    expect(h.seen.every((x) => x.n === 12 && x.btc === 12)).toBe(true);
    expect(r).toEqual({ coins: 3, evaluated: 3, fired: 0, new: 0, woken: 0, pushed: 0, capped: 0, undelivered: 0, expired: 0, calibration: "defaults", lines: [] });
    expect(h.seen.every((x) => x.th === DEFAULT_EXTREME_THRESHOLDS)).toBe(true);
  });

  test("thresholds: the latest applied calibration (a proposal is ignored); a row that does not parse falls back to the defaults", async () => {
    const store = await storeWith(["SOL", "BTC"]);
    const run = (thresholds: unknown, applied: boolean, h: number) => ({
      ranAt: iso(NOW - h * HOUR), from: null, to: null, coins: ["SOL"], result: resetResult({ perWeek: 1, min: 0.5, max: 1.5 }, NOW), thresholds: thresholds as typeof DEFAULT_EXTREME_THRESHOLDS, applied,
    });
    const strict = withMultiplier(DEFAULT_EXTREME_THRESHOLDS, "oi_flush", 1.25);
    const saved = await store.insertExtremeCalibration(run(strict, true, 3));
    await store.insertExtremeCalibration(run(withMultiplier(DEFAULT_EXTREME_THRESHOLDS, "oi_flush", 0.5), false, 1));
    let h = harness(store);
    expect((await runExtremesJob(h.deps)).calibration).toEqual({ id: saved.id, ranAt: saved.ranAt });
    expect(h.seen.map((x) => x.th)).toEqual([strict, strict]);
    // a newer applied row whose thresholds no longer parse (written by hand, or by an older schema): the code defaults
    store.calibrations.push({ ...saved, id: 99, ranAt: iso(NOW - HOUR), thresholds: { price: "nope" } });
    const logs: string[] = [];
    h = harness(store);
    h.deps.thresholds = () => appliedThresholds(store, (m) => logs.push(m));
    expect((await runExtremesJob(h.deps)).calibration).toBe("defaults");
    expect(h.seen.every((x) => x.th === DEFAULT_EXTREME_THRESHOLDS)).toBe(true);
    await runExtremesJob(h.deps);
    expect(logs.length).toBe(1); // logged once
    expect(logs[0]).toMatch(/calibration 99 .* code defaults/);
  });

  test("nothing new: no wake, no push, nothing stored", async () => {
    const store = await storeWith(["SOL"]);
    const h = harness(store, { wake: true });
    await runExtremesJob(h.deps);
    expect(h.woken).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(store.extremes.size).toBe(0);
  });

  test("a woken batch: one wake for every new event, stored as woken, no push", async () => {
    const store = await storeWith(["SOL", "ETH"]);
    const h = harness(store, { wake: true, fire: { SOL: [ev("SOL", 4)], ETH: [ev("ETH", 5)] } });
    const r = await runExtremesJob(h.deps);
    expect(h.woken.map((b) => b.map((e) => e.coin))).toEqual([["ETH", "SOL"]]); // strongest first
    expect(h.sent).toEqual([]);
    expect(r).toMatchObject({ fired: 2, new: 2, woken: 2, pushed: 0, capped: 0, lines: ["ETH OI -20% in 4h", "SOL OI -20% in 4h"] });
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.delivery).toBe("woken");
  });

  test("wake fails (false or throws): each event is pushed once through the notifier, with the coin link", async () => {
    for (const wake of [false, "throw"] as const) {
      const store = await storeWith(["SOL"]);
      const h = harness(store, { wake, fire: { SOL: [ev("SOL", 4)] } });
      const r = await runExtremesJob(h.deps);
      expect(h.woken.length).toBe(1);
      expect(h.sent).toEqual([{ level: "info", title: "Extreme: SOL oi_flush", body: "SOL OI -20% in 4h", click: "https://app.example/coin/SOL" }]);
      expect(r).toMatchObject({ new: 1, woken: 0, pushed: 1 });
      expect((await store.latestExtreme("oi_flush|SOL|long"))!.delivery).toBe("pushed");
    }
  });

  test("a push no channel took is stored as none and counted undelivered", async () => {
    const store = await storeWith(["SOL"]);
    const h = harness(store, { channels: [], fire: { SOL: [ev("SOL", 4)] } });
    const r = await runExtremesJob(h.deps);
    expect(r).toMatchObject({ pushed: 0, undelivered: 1 });
    expect((await store.latestExtreme("oi_flush|SOL|long"))!.delivery).toBe("none");
  });

  test("cooldown: the same key inside EXTREMES_COOLDOWN_H is dropped, after it fires again; one event per key per run", async () => {
    const store = await storeWith(["SOL"]);
    const fire = { SOL: [ev("SOL", 4), ev("SOL", 3, { window: "24h" })] };
    const first = harness(store, { fire });
    expect((await runExtremesJob(first.deps)).new).toBe(1);
    expect(first.sent.length).toBe(1);

    await storeWith(["SOL"], NOW + 23 * HOUR, store);
    await storeWith(["SOL"], NOW + 24 * HOUR, store);
    const again = harness(store, { fire: { SOL: [ev("SOL", 6, { ts: iso(NOW + 23 * HOUR) })] }, now: NOW + 23 * HOUR });
    const r = await runExtremesJob(again.deps);
    expect(r).toMatchObject({ fired: 1, new: 0 });
    expect(again.sent).toEqual([]);

    const later = harness(store, { fire: { SOL: [ev("SOL", 6, { ts: iso(NOW + 24 * HOUR) })] }, now: NOW + 24 * HOUR, env: { EXTREMES_COOLDOWN_H: "24" } });
    expect((await runExtremesJob(later.deps)).new).toBe(1);
  });

  test("records are stored before anything is sent: an event whose store write fails is not sent, and no event is sent twice", async () => {
    const coins = ["A", "B", "C"];
    const store = await storeWith(coins);
    const fire = Object.fromEntries(coins.map((c, i) => [c, [ev(c, 10 - i)]]));
    const insert = store.insertExtremeEvent.bind(store);
    store.insertExtremeEvent = async (r) => {
      if (r.event.coin === "B") throw new Error("db down");
      return insert(r);
    };
    const first = harness(store, { fire });
    const r = await runExtremesJob(first.deps);
    expect(first.sent.map((a) => a.title)).toEqual(["Extreme: A oi_flush", "Extreme: C oi_flush"]);
    expect(r).toMatchObject({ fired: 3, new: 2, pushed: 2 });
    expect((await store.latestExtreme("oi_flush|A|long"))!.delivery).toBe("pushed");
    expect(await store.latestExtreme("oi_flush|B|long")).toBeNull();

    // The store is back: B goes out once, A and C stay inside their cooldown.
    store.insertExtremeEvent = insert;
    const next = harness(store, { fire });
    await runExtremesJob(next.deps);
    expect(next.sent.map((a) => a.title)).toEqual(["Extreme: B oi_flush"]);
  });

  test("two overlapping runs: the stored record is the claim, so each event goes out once", async () => {
    const store = await storeWith(["SOL", "ETH"]);
    const fire = { SOL: [ev("SOL", 4)], ETH: [ev("ETH", 5)] };
    const a = harness(store, { fire });
    const b = harness(store, { fire });
    const [ra, rb] = await Promise.all([runExtremesJob(a.deps), runExtremesJob(b.deps)]);
    expect([...a.sent, ...b.sent].map((x) => x.title).sort()).toEqual(["Extreme: ETH oi_flush", "Extreme: SOL oi_flush"]);
    expect(ra.new + rb.new).toBe(2);
    expect(store.extremes.size).toBe(2);
  });

  test("daily cap: at most EXTREMES_DAILY_CAP delivered per UTC day; the rest stored with delivery none and nothing sent", async () => {
    const coins = ["A", "B", "C", "D"];
    const store = await storeWith(coins);
    const fire = Object.fromEntries(coins.map((c, i) => [c, [ev(c, 10 - i)]]));
    const h = harness(store, { fire, env: { EXTREMES_DAILY_CAP: "3" } });
    const r = await runExtremesJob(h.deps);
    expect(r).toMatchObject({ new: 4, pushed: 3, capped: 1 });
    expect(h.sent.map((a) => a.title)).toEqual(["Extreme: A oi_flush", "Extreme: B oi_flush", "Extreme: C oi_flush"]);
    expect((await store.latestExtreme("oi_flush|D|long"))!.delivery).toBe("none");

    // Same UTC day, a new key: the cap is spent, so it is stored and not sent; the wake is not called either.
    const more = harness(store, { wake: true, fire: { A: [ev("A", 9, { key: "price_dislocation|A|short", kind: "price_dislocation", side: "short" })] }, env: { EXTREMES_DAILY_CAP: "3" } });
    expect(await runExtremesJob(more.deps)).toMatchObject({ new: 1, capped: 1, woken: 0, pushed: 0 });
    expect(more.woken).toEqual([]);
    expect(more.sent).toEqual([]);
  });

  test("expiry: a ready extremes take past EXTREMES_READY_TTL_H expires (the serverless runtime has no scanner); scanner rows are left alone", async () => {
    const store = await storeWith(["SOL"]);
    const mk = async (setupKind: string, scoreVersion: string, coin = "SOL") => {
      const { opportunity: o } = await store.upsertOpportunity(
        { coin, direction: "long", setupKind, tradeType: "directional", score: 5, scoreVersion, tags: [], liquidityTier: 1, regime: "unknown", invalidation: "x", entryPx: 10, stopPx: 9, targetPx: null, invalidationPx: 9 },
        { features: { features: {}, inputs: {} }, market: {}, score: 5, scoreVersion },
      );
      await store.transitionOpportunity(o.id, "new", "calculated", "system");
      await store.transitionOpportunity(o.id, "calculated", "ready", "system");
      store.opportunities.get(o.id)!.statusChangedAt = iso(NOW - 3 * HOUR);
      return o.id;
    };
    const take = await mk("oi_flush", EXTREMES_SCORE_VERSION);
    const scanner = await mk("crowded_long", "score-v2");
    expect((await runExtremesJob(harness(store).deps)).expired).toBe(0); // 3 h < the 4 h default
    const r = await runExtremesJob(harness(store, { env: { EXTREMES_READY_TTL_H: "2" } }).deps);
    expect(r.expired).toBe(1);
    expect((await store.getOpportunity(take))!.status).toBe("expired");
    expect((await store.getOpportunity(scanner))!.status).toBe("ready"); // past the scanner's 60 min, but not ours to expire
  });

  test("extremeAlert without APP_URL has no link", () => {
    expect(extremeAlert(ev("SOL", 1), null)).toEqual({ level: "info", title: "Extreme: SOL oi_flush", body: "SOL OI -20% in 4h" });
  });
});
