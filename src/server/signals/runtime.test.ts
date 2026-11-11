import { describe, expect, test } from "bun:test";
import { isoDate } from "../lab/engine/util.js";
import { DAY_MS, type LabDataset } from "../lab/types.js";
import { createHtProvider } from "../lab/providers/ht.js";
import { createOkxProvider } from "../lab/providers/okx.js";
import { loadDataset } from "../lab/providers/registry.js";
import { SOURCE_TIMEOUT_MS, SourceUnavailable } from "../research/board.js";
import { boardDefinitionScan } from "./runtime.js";
import { createDefinitionScanner } from "./scan.js";

describe("the board's definition source", () => {
  const NOW = Date.UTC(2026, 10, 10, 12);
  const bar = Math.floor(NOW / DAY_MS) * DAY_MS - DAY_MS;
  const dataset: LabDataset = { asset: "AAA", t: [bar - DAY_MS, bar], price: [1, 1], metrics: {} };
  /** A scanner whose one coin loads only when `release` is called. */
  function gated() {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let loads = 0;
    const scanner = createDefinitionScanner({
      loadDataset: async () => (loads++, await gate, { dataset, warnings: [], lastRaw: { "ht:price": isoDate(bar) } }),
      coins: async () => ["AAA"],
      now: () => NOW,
      definitions: [],
      deadlineMs: Infinity,
    });
    return { scanner, release, loads: () => loads };
  }

  test("without a database: never waits for the scan; null while the first runs, then the last finished scan", async () => {
    const g = gated();
    expect(await boardDefinitionScan(g.scanner, false)).toBeNull(); // first scan started, not awaited
    expect(await boardDefinitionScan(g.scanner, false)).toBeNull(); // still in progress: the same scan, not a second
    expect(g.loads()).toBe(1);
    g.release();
    const done = await g.scanner.scan();
    expect(await boardDefinitionScan(g.scanner, false)).toBe(done);
    expect(done).toMatchObject({ bar: isoDate(bar), coins: 1, dropped: 0 });
  });

  test("with a database: the day's scan, awaited (the board's source timeout bounds it), serverless or not", async () => {
    for (const serverless of [false, true]) {
      const g = gated();
      const p = boardDefinitionScan(g.scanner, true, serverless);
      g.release();
      expect(await p).toMatchObject({ bar: isoDate(bar), coins: 1 });
    }
  });

  test("the production path (Vercel with a database): the scan runs inline from stored candles, funding and collected okx:oi, no live request", async () => {
    const live: string[] = [];
    const days = 260;
    const firstDay = bar - (days - 1) * DAY_MS;
    const H = 3_600_000;
    const candles = Array.from({ length: days }, (_, i) => {
      const c = 100 * (1 + 0.05 * Math.sin(i / 7));
      return { t: firstDay + i * DAY_MS, o: c, h: c * 1.01, l: c * 0.99, c, v: 1e6 * (1 + 0.3 * Math.cos(i / 5)) };
    });
    const funding = Array.from({ length: days * 24 }, (_, i) => ({ t: firstDay + i * H, rate: 1e-5 * (1 + Math.sin(i / 50)), premium: 0 })); // through 23:00 on the bar
    const oi = Array.from({ length: days }, (_, i) => ({ t: firstDay + i * DAY_MS, v: 1e9 * (1 + 0.1 * Math.sin(i / 9)) })); // lab-collect's rows, through the bar
    const ht = createHtProvider({
      hasDb: () => true,
      ensureHistory: async () => {},
      candles: async (_c, from) => candles.filter((x) => x.t >= from),
      funding: async (_c, from, to) => funding.filter((x) => x.t >= from && x.t <= to),
      series: async () => [],
      liveCandles: async (c) => (live.push(`hl candles ${c}`), []),
      liveFunding: async (c) => (live.push(`hl funding ${c}`), []),
      now: () => NOW,
    });
    const okx = createOkxProvider({ fetchFn: (async (u: string) => (live.push(`okx ${u}`), Response.json({ code: "0", data: [] }))) as unknown as typeof fetch, now: () => NOW, sleep: async () => {} });
    const store = {
      hasDb: () => true,
      coverage: async (id: string) => (id === "lab.okx.oi.eth" ? { min: oi[0]!.t, max: oi.at(-1)!.t } : null),
      range: async (id: string, lo: number, hi: number) => (id === "lab.okx.oi.eth" ? oi.filter((p) => p.t >= lo && p.t <= hi) : []),
    };
    const scanner = createDefinitionScanner({
      loadDataset: (cfg) => loadDataset(cfg, { providers: [ht, okx], store, now: () => NOW, cache: new Map() }),
      coins: async () => ["ETH"],
      listed: async () => new Set(["ETH"]),
      now: () => NOW,
    });
    const t0 = performance.now();
    const scan = await boardDefinitionScan(scanner, true, true);
    expect(performance.now() - t0).toBeLessThan(SOURCE_TIMEOUT_MS);
    expect(live).toEqual([]);
    expect(scan).toMatchObject({ bar: isoDate(bar), coins: 1, dropped: 0 }); // every definition evaluated, OI ones included
  });

  test("serverless without a database: unavailable with the reason, and no scan is started", async () => {
    const g = gated();
    const err = await boardDefinitionScan(g.scanner, false, true).catch((e) => e);
    expect(err).toBeInstanceOf(SourceUnavailable);
    expect(err.reason).toBe("needs a database or the always-on server; or run `bun run signals:scan`");
    expect(g.loads()).toBe(0);
    expect(g.scanner.latest()).toBeNull();
  });
});
