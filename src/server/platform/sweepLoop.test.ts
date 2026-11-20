import { describe, expect, test } from "bun:test";
import { bucketIndex, type LiqMapSnapshot, type StopMapSnapshot } from "../../shared/platform.js";
import type { AssetCtx, Candle } from "../../shared/types.js";
import { buildBoard } from "../routine/board.js";
import { evaluateTripwires } from "../routine/tripwires.js";
import { createSweepLoop, evaluateCoin, oiChangeOverBar, sweepAlert } from "./sweepLoop.js";

// Parity (CLAUDE.md: a second evaluation path needs a parity test): the live loop and the board tripwire read one
// fixture through the same composition and agree on the sweep, what it cleared, and whether it is worth a push.

const H = 3_600_000;
const H4 = 4 * H;
const DAY = 24 * H;
const D = Date.UTC(2026, 10, 18); // a Wednesday, 00:00 UTC
const CLOSE = D + 8 * H; // the swept 4h bar is [D+4h, D+8h)
const NOW = CLOSE + 2 * 60_000;

/** 130 flat daily bars (99–101) up to D, the day before D dipping to 98: the PDL. */
const c1d: Candle[] = Array.from({ length: 131 }, (_, k) => {
  const t = D - (130 - k) * DAY;
  return { t, T: t + DAY - 1, o: 100, h: 101, l: t === D - DAY ? 98 : 99, c: 100, v: 1 };
});
/** 35 days of flat 4h bars (99.5–100.5); the last closed one wicks to 97.6 and closes back at 99.5. */
const c4h: Candle[] = Array.from({ length: (35 * DAY) / H4 + 2 }, (_, k) => {
  const t = CLOSE - (35 * DAY) / H4 * H4 + (k - 1) * H4;
  return t === CLOSE - H4 ? { t, T: t + H4 - 1, o: 100, h: 100.3, l: 97.6, c: 99.5, v: 1 } : { t, T: t + H4 - 1, o: 100, h: 100.5, l: 99.5, c: 100, v: 1 };
}).filter((c) => c.t < NOW);

const cell = (px: number, longUsd: number) => ({ idx: bucketIndex(px, 25), longUsd, shortUsd: 0 });
const pre: LiqMapSnapshot = { coin: "SOL", ts: new Date(CLOSE - H4 - 10 * 60_000).toISOString(), mark: 100, bucketBps: 25, buckets: [cell(97.8, 3_000_000), cell(96, 1_000_000)] };
const post: LiqMapSnapshot = { ...pre, ts: new Date(CLOSE + 60_000).toISOString(), buckets: [cell(96, 1_000_000)] };
const snapshots = [pre, post];
/** Resting long stops just under the 98 level before the bar (crawled wallets' sell stops). */
const stops: StopMapSnapshot[] = [{ coin: "SOL", ts: new Date(CLOSE - H4 - 5 * 60_000).toISOString(), mark: 100, bucketBps: 25, buckets: [cell(97.85, 750_000)], wallets: 4 }];
const OI_USD = 400_000_000; // limit = 0.25% = $1M
const samples = [
  { ts: new Date(CLOSE - H4 - 5 * 60_000).toISOString(), inputs: { oiUsd: 400_000_000, mark: 100 } },
  { ts: new Date(CLOSE - 5 * 60_000).toISOString(), inputs: { oiUsd: 380_000_000, mark: 100 } },
];
const ctx = { name: "SOL", markPx: 100, openInterest: OI_USD / 100, funding: 0.0000125, premium: 0, dayNtlVlm: 1e9, dayChange: 0, isDelisted: false } as AssetCtx;

describe("sweep loop ↔ board tripwire parity", () => {
  const board = buildBoard([{ ctx, c4h, c1d, funding: null, cexHourly: [], liqmap: { snapshots, coverageRatio: 0, stops } }], null, new Date(NOW));
  const row = board.rows[0]!;
  const evals = evaluateCoin({ coin: "SOL", c4h, c1d, now: NOW, liqmap: { snapshots, coverageRatio: 0, stops }, oiUsd: OI_USD, samples });

  test("both paths find the same reclaimed sweep of the PDL zone and the same cleared notional", () => {
    expect(evals).toHaveLength(1);
    const e = evals[0]!;
    expect(e.sweep).toEqual(row.tf["4h"]!.liqSweep!);
    expect(e.cleared).toEqual(row.tf["4h"]!.cleared!);
    expect(["pdl", "pwl"]).toContain(e.sweep.level.source); // the prior week's low is the same 98: they merge
    expect([e.sweep.level.px, e.sweep.side, e.sweep.reclaimed, e.sweep.wick]).toEqual([98, "low", true, 97.6]);
    expect(e.cleared!.clearedUsd).toBeGreaterThan(1_000_000); // the post-bar snapshot (longs gone) is not read
    expect(e.oiChgPct).toBe(-5);
    expect(e.cleared!.stopsUsd).toBe(750_000); // the stop cell lies inside [97.6, 98]
  });

  test("the loop pushes exactly when the tripwire's sweep, reclaim and cleared-$ conditions pass", () => {
    const at = (oiUsd: number) => {
      const r = { ...row, pos: { ...row.pos, oiUsd, oiChg24hPct: -3 } };
      const tw = evaluateTripwires([r]);
      const read = [...tw.hits, ...tw.near].find((t) => t.setup_id === "liquidity_sweep" && t.direction === "long");
      return { tripwire: read?.status === "hit", push: sweepAlert({ ...evals[0]!, oiUsd }) !== null };
    };
    expect(at(OI_USD)).toEqual({ tripwire: true, push: true }); // limit $1M, cleared above it
    expect(at(4e10)).toEqual({ tripwire: false, push: false }); // limit $5M, cleared below it
  });

  test("no snapshot: the loop stays silent, the tripwire shows a near-miss", () => {
    const [e] = evaluateCoin({ coin: "SOL", c4h, c1d, now: NOW, liqmap: { snapshots: [post], coverageRatio: 0 }, oiUsd: OI_USD, samples });
    expect(e!.cleared).toBeNull();
    expect(sweepAlert(e!)).toBeNull();
  });
});

describe("sweep loop", () => {
  const meta = { universe: [{ name: "SOL", szDecimals: 2, maxLeverage: 20 }] };
  const raw = [meta, [{ funding: "0.00001", openInterest: String(OI_USD / 100), prevDayPx: "100", dayNtlVlm: "1000000000", premium: "0", oraclePx: "100", markPx: "100", midPx: "100", impactPxs: ["100", "100"], dayBaseVlm: "1" }]];

  function loop(now: () => number) {
    const pushes: Array<[string, string, string]> = [];
    const l = createSweepLoop({
      store: { listPositions: async () => [], liqmapHistory: async () => snapshots, stopmapHistory: async () => stops, scanSnapshotsSince: async () => samples.map((s) => ({ coin: "SOL", ...s })) },
      notify: async (...a) => void pushes.push(a),
      info: (async () => raw) as never,
      candles: async (_coin, interval) => (interval === "4h" ? c4h : c1d),
      now,
      coins: 1,
    });
    return { l, pushes };
  }

  test("one fact-only push at the 4h close, none on the next beat or before the close settles", async () => {
    let t = CLOSE + 30_000;
    const { l, pushes } = loop(() => t);
    expect(await l.tick()).toEqual([]); // inside the 60 s settle
    t = NOW;
    expect(await l.tick()).toHaveLength(1);
    t = NOW + 60_000;
    expect(await l.tick()).toEqual([]);
    expect(pushes).toHaveLength(1);
    const [title, body, path] = pushes[0]!;
    expect(title).toMatch(/^Sweep: SOL 4h /);
    expect(body).toContain("closed back inside");
    expect(body).toContain("OI over the bar -5.0%");
    expect(body).toContain("Resting long stops in that zone before the bar: $750.00K");
    expect(body).not.toMatch(/\b(buy|sell|long now|short now|should)\b/i);
    expect(path).toBe("/coin/SOL");
  });

  test("a close first seen after the evaluation window is skipped, not evaluated late", async () => {
    const { l, pushes } = loop(() => CLOSE + 20 * 60_000);
    expect(await l.tick()).toEqual([]);
    expect(pushes).toEqual([]);
  });

  test("oiChangeOverBar: null without a sample at the bar's open", () => {
    expect(oiChangeOverBar(samples.slice(1), { t: CLOSE - H4, T: CLOSE - 1 })).toBeNull();
  });
});
