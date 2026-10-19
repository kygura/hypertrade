import { describe, expect, test } from "bun:test";
import { alignDaily, createNoveltyLoop, storedInputs, type RawInputs } from "./noveltyLoop.js";
import { MemoryPlatformStore } from "./store-memory.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 1, 10, 0, 30); // newest closed bar: 2026-02-09
const T0 = Date.UTC(2026, 1, 9) - 399 * DAY;

/** 400 closed daily bars (+ today's forming one) with a funding extreme on the last closed bar; OI absent. */
function raw(lastFunding: number): RawInputs {
  let s = 7;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5;
  const bars = Array.from({ length: 401 }, (_, i) => ({ t: T0 + i * DAY, c: 100 + i * 0.01 + rnd(), v: 1 + 0.2 * rnd() }));
  const funding = Array.from({ length: 400 }, (_, i) => ({ t: T0 + i * DAY + 3_600_000, rate: i === 399 ? lastFunding : [100, 101, 102].includes(i) ? 0.01 : 1e-4 + 4e-5 * rnd() }));
  return { bars, funding, oi: [] };
}

describe("alignDaily()", () => {
  test("drops the forming bar and leaves unknown funding and OI as null", () => {
    const r = raw(1e-4);
    const d = alignDaily({ ...r, funding: r.funding.slice(300) }, NOW);
    expect(d.t).toHaveLength(400);
    expect(d.f[0]).toBeNull();
    expect(d.f[399]).toBe(1e-4);
    expect(d.oi.every((x) => x === null)).toBe(true);
  });
});

describe("novelty loop", () => {
  const setup = (lastFunding: number, now = NOW, inputsOver?: (coin: string) => Promise<RawInputs>) => {
    const store = new MemoryPlatformStore();
    const sent: string[] = [];
    let channels = ["telegram"];
    const loop = createNoveltyLoop({
      store, now: () => now, maxTier: 1,
      universe: async () => [{ coin: "SOL", dayNtlVlm: 5, oiUsd: 5 }, { coin: "DOGE", dayNtlVlm: 1, oiUsd: 1 }, { coin: "PEPE", dayNtlVlm: 0.5, oiUsd: 1 }],
      inputs: inputsOver ? async (c) => inputsOver(c) : async () => raw(lastFunding),
      notify: async (e) => (sent.push(e.id), channels),
    });
    return { store, sent, loop, setChannels: (c: string[]) => (channels = c) };
  };

  test("a funding extreme on the newest closed bar is journalled, pushed once, stamped delivered; a rerun adds nothing", async () => {
    const { store, sent, loop } = setup(0.05);
    await loop.tick();
    const [e] = await store.listNovelty("2026-02-01");
    expect(e).toMatchObject({ id: "2026-02-09:SOL", kind: "new_extreme", pushed: true, notified: [{ channels: ["telegram"] }] });
    await loop.tick();
    expect(sent).toEqual(["2026-02-09:SOL"]);
    expect(await store.listNovelty("2026-02-01")).toHaveLength(1);
  });

  test("an undelivered push is retried next beat; a quiet bar journals nothing; only tier-1 coins are checked", async () => {
    const quiet = setup(1e-4);
    await quiet.loop.tick();
    expect(await quiet.store.listNovelty("2026-02-01")).toEqual([]);
    const { store, sent, loop, setChannels } = setup(0.05);
    setChannels([]);
    await loop.tick();
    await loop.tick();
    expect(sent).toEqual(["2026-02-09:SOL", "2026-02-09:SOL"]);
    setChannels(["ntfy"]);
    await loop.tick();
    expect((await store.listNovelty("2026-02-01")).map((x) => x.coin)).toEqual(["SOL"]);
    expect((await store.listNovelty("2026-02-01"))[0]!.notified).toHaveLength(1);
  });

  test("a coin that threw is re-checked next beat, not lost with the bar", async () => {
    let calls = 0;
    const { store, loop } = setup(0.05, NOW, async () => {
      if (calls++ === 0) throw new Error("hl down");
      return raw(0.05);
    });
    const log = console.error;
    console.error = () => {};
    await loop.tick();
    console.error = log;
    expect(await store.listNovelty("2026-02-01")).toEqual([]);
    await loop.tick();
    expect((await store.listNovelty("2026-02-01")).map((e) => e.id)).toEqual(["2026-02-09:SOL"]);
  });

  test("a bar not stored yet is retried; a fresh loop (restart) backfills the downtime window", async () => {
    let stored = false;
    const { store, loop } = setup(0.05, NOW, async () => {
      const r = raw(0.05);
      return stored ? r : { ...r, bars: r.bars.filter((b) => b.t < Date.UTC(2026, 1, 9)) };
    });
    await loop.tick();
    expect(await store.listNovelty("2026-02-01")).toEqual([]);
    stored = true;
    await loop.tick();
    expect((await store.listNovelty("2026-02-01")).map((e) => e.id)).toEqual(["2026-02-09:SOL"]);
    // restart two beats later: the extreme is two bars back, still inside the 3-bar window
    const restarted = setup(0.05, NOW + DAY);
    await restarted.loop.tick();
    expect((await restarted.store.listNovelty("2026-02-01")).map((e) => e.id)).toEqual(["2026-02-09:SOL"]);
  });
});

describe("storedInputs()", () => {
  test("syncs from now-400d but reads the baseline from the start of the stored history", async () => {
    const calls: Record<string, unknown[]> = {};
    const rec = (k: string, v: unknown) => async (...a: unknown[]) => ((calls[k] = a), v as never);
    const ht = { ensureHistory: rec("ensure", undefined), candles: rec("candles", []), funding: rec("funding", []), series: rec("series", []) };
    await storedInputs(ht, (async (...a: unknown[]) => ((calls.sync = a), {})) as never)("SOL", NOW);
    expect(calls.ensure![1]).toBe(NOW - 400 * DAY);
    expect(calls.sync![1]).toBe(NOW - 400 * DAY);
    expect(calls.candles).toEqual(["SOL", 0]);
    expect(calls.funding).toEqual(["SOL", 0, NOW]);
    expect(calls.series).toEqual(["hl.oi.SOL", 0, NOW]);
  });
});

describe("novelty universe filter", () => {
  const all = [["A", 7], ["B", 6], ["C", 5], ["D", 4], ["E", 3], ["F", 2], ["ZEC", 1]].map(([coin, v]) => ({ coin: coin as string, dayNtlVlm: v as number, oiUsd: v as number }));
  const checked = async (over: Partial<Parameters<typeof createNoveltyLoop>[0]>) => {
    const seen: string[] = [];
    const loop = createNoveltyLoop({ store: new MemoryPlatformStore(), now: () => NOW, maxTier: 1, universe: async () => all, inputs: async (c) => (seen.push(c), raw(1e-4)), notify: async () => [], ...over });
    await loop.tick();
    return [...new Set(seen)].sort();
  };

  test("default: liquidity gate plus my markets", async () => {
    expect(await checked({})).toEqual(["A", "B", "C", "ZEC"]);
  });
  test("top filter replaces the gate", async () => {
    expect(await checked({ filter: { top: 2 } })).toEqual(["A", "B"]);
  });
  test("sectors filter uses the tags; mine adds", async () => {
    const tags = async () => ({ E: ["AI"], F: ["Meme"] });
    expect(await checked({ filter: { sectors: ["AI"] }, tags })).toEqual(["E"]);
    expect(await checked({ filter: { sectors: ["AI"], mine: ["F"] }, tags })).toEqual(["E", "F"]);
  });
});
