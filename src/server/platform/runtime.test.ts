import { describe, expect, test } from "bun:test";
import { leased, parseWorkerLoops, startLoops, type RunLease } from "./runtime";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("parseWorkerLoops", () => {
  test("all / off / list", () => {
    expect(parseWorkerLoops(undefined)).toBe("all");
    expect(parseWorkerLoops(" ALL ")).toBe("all");
    expect([...(parseWorkerLoops("off") as Set<string>)]).toEqual([]);
    expect([...(parseWorkerLoops("") as Set<string>)]).toEqual([]);
    expect([...(parseWorkerLoops("ws, desk ,,prune") as Set<string>)]).toEqual(["ws", "desk", "prune"]);
  });
});

describe("startLoops", () => {
  test("a throwing loop keeps the others beating and reports its error", async () => {
    let good = 0;
    const loops = startLoops(
      [
        { name: "bad", intervalSec: 0.01, run: async () => { throw new Error("boom"); } },
        // Health window is 3x expectedIntervalSec on the wall clock; 1 s keeps a slow CI runner
        // from reading a 10 ms beat as stale.
        { name: "good", intervalSec: 0.01, expectedIntervalSec: 1, run: async () => void good++ },
      ],
      { errorBackoffSec: 0.01, log: () => {} },
    );
    await wait(80);
    const h = Object.fromEntries(loops.health().map((l) => [l.name, l]));
    expect(good).toBeGreaterThan(2);
    expect(h.good!.ok).toBe(true);
    expect(h.good!.lastBeatAt).not.toBeNull();
    expect(h.bad!.ok).toBe(false);
    expect(h.bad!.error).toBe("boom");
    expect(h.bad!.lastBeatAt).toBeNull();
    await loops.stop();
  });

  test("only filters loops; stop halts them", async () => {
    let a = 0, b = 0;
    const loops = startLoops(
      [{ name: "a", intervalSec: 0.01, run: async () => void a++ }, { name: "b", intervalSec: 0.01, run: async () => void b++ }],
      { only: new Set(["a"]) },
    );
    await wait(40);
    await loops.stop();
    const seen = a;
    await wait(40);
    expect(b).toBe(0);
    expect(a).toBe(seen);
    expect(loops.health().map((l) => l.name)).toEqual(["a"]);
  });

  test("a loop that never beats goes unhealthy after 3x its interval", () => {
    let t = 0;
    const loops = startLoops([{ name: "x", intervalSec: 10, run: () => new Promise(() => {}) }], { now: () => t });
    t = 29_000;
    expect(loops.health()[0]!.ok).toBe(true);
    t = 31_000;
    expect(loops.health()[0]!.ok).toBe(false);
  });
});

describe("leased", () => {
  /** An in-memory lease with the db.ts semantics: one holder until it releases or its TTL runs out. */
  function fakeLease(clock: { t: number }) {
    let held: { holder: string; until: number } | null = null;
    const lease: RunLease = {
      acquire: async (holder, ttlMs) => {
        if (held && held.until > clock.t) return false;
        held = { holder, until: clock.t + ttlMs };
        return true;
      },
      release: async (holder) => void (held?.holder === holder && (held.until = clock.t)),
    };
    return { lease, take: (ttlMs: number) => lease.acquire("cron", ttlMs) };
  }

  test("skips the tick while the cron route holds the lease, runs once it is released or expired", async () => {
    const clock = { t: 0 };
    const { lease, take } = fakeLease(clock);
    let runs = 0;
    const def = leased({ name: "novelty", intervalSec: 3600, run: async () => void runs++ }, lease, 1_000);
    expect(await take(5_000)).toBe(true);
    await def.run();
    expect(runs).toBe(0);
    clock.t = 5_000; // the cron holder crashed: its lease runs out, the loop is not blocked for good
    await def.run();
    expect(runs).toBe(1);
    expect(await take(5_000)).toBe(true); // released after the run
  });

  test("two overlapping runs: the second skips; the lease is released when the run throws", async () => {
    const clock = { t: 0 };
    const { lease, take } = fakeLease(clock);
    let runs = 0;
    let fail = false;
    let open!: () => void;
    const def = leased({ name: "scanner", intervalSec: 60, run: async () => {
      runs++;
      if (fail) throw new Error("boom");
      await new Promise<void>((r) => (open = r));
    } }, lease, 60_000);
    const first = def.run();
    await def.run();
    expect(runs).toBe(1);
    open();
    await first;
    fail = true;
    await expect(def.run()).rejects.toThrow("boom");
    expect(await take(1)).toBe(true);
  });
});
