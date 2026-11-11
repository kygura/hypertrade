import { describe, expect, test } from "bun:test";
import { isoDate } from "../lab/engine/util.js";
import { DAY_MS, type LabDataset } from "../lab/types.js";
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

  test("with a database: the day's scan, awaited (the board's source timeout bounds it)", async () => {
    const g = gated();
    const p = boardDefinitionScan(g.scanner, true);
    g.release();
    expect(await p).toMatchObject({ bar: isoDate(bar), coins: 1 });
  });
});
