import { describe, expect, test } from "bun:test";
import { parseWorkerLoops, startLoops } from "./runtime";

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
        { name: "good", intervalSec: 0.01, run: async () => void good++ },
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
