import { describe, expect, test } from "bun:test";
import { RadarCallsInputSchema, type RadarCallInput, type RadarCallsFile } from "../../shared/radar.js";
import { gradeCalls, landCalls, scorecard } from "./calls.js";
import type { RadarMarket } from "./scan.js";

const mk = (key: string, mark: number): RadarMarket => ({ key, dex: "main", mark, chg24hPct: 0, vol24h: 1e7, oiUsd: 1e7, fundingApr: 11, premiumBps: 0, atCap: false });
const call = (o: Partial<RadarCallInput> = {}): RadarCallInput => ({
  market: "HYPE",
  stance: "ride",
  kind: "catalyst",
  thesis: "ICE strategic investment in Trade[XYZ]; HIP-3 deployers stake HYPE",
  cause_url: "https://ir.theice.com/press",
  cause_date: "2026-10-29",
  kill_if: "4h close back under the pre-news range",
  ...o,
});
const AT = "2026-10-30T07:41:00Z";
const empty: RadarCallsFile = { calls: [] };

describe("call input schema", () => {
  test("a ride or fade needs a dated source; url and date go together; at most 3 calls", () => {
    expect(RadarCallsInputSchema.safeParse({ calls: [call()] }).success).toBe(true);
    expect(RadarCallsInputSchema.safeParse({ calls: [call({ cause_url: null, cause_date: null })] }).success).toBe(false);
    expect(RadarCallsInputSchema.safeParse({ calls: [call({ stance: "watch", cause_url: null, cause_date: null })] }).success).toBe(true);
    expect(RadarCallsInputSchema.safeParse({ calls: [call({ cause_date: null })] }).success).toBe(false);
    expect(RadarCallsInputSchema.safeParse({ calls: [call(), call(), call(), call()] }).success).toBe(false);
  });
});

describe("landCalls", () => {
  test("stamps prices from the scan, never from the model", () => {
    const r = landCalls([call()], [mk("BTC", 100), mk("HYPE", 90)], empty, "2026-10-30", AT);
    expect(r.rejected).toEqual([]);
    expect(r.landed[0]).toMatchObject({ id: "2026-10-30-1-HYPE", mark: 90, btc: 100, rel: {} });
  });

  test("unknown market and repeats within 3 days are dropped", () => {
    const first = landCalls([call()], [mk("BTC", 100), mk("HYPE", 90)], empty, "2026-10-30", AT);
    const r = landCalls([call(), call({ market: "NOPE" }), call({ stance: "fade" })], [mk("BTC", 100), mk("HYPE", 95)], first.file, "2026-11-01", AT);
    expect(r.rejected).toEqual([
      { market: "HYPE", reason: "repeat of 2026-10-30-1-HYPE" },
      { market: "NOPE", reason: "not a live market in this scan" },
    ]);
    expect(r.landed.map((c) => c.stance)).toEqual(["fade"]);
    const later = landCalls([call()], [mk("BTC", 100), mk("HYPE", 95)], first.file, "2026-11-03", AT);
    expect(later.landed).toHaveLength(1);
  });
});

describe("gradeCalls and scorecard", () => {
  const state = {
    days: [
      { date: "2026-11-02", at: "", marks: { BTC: [110, 0, 0] as [number, number, number], HYPE: [99, 0, 0] as [number, number, number] } },
      { date: "2026-11-06", at: "", marks: { BTC: [100, 0, 0] as [number, number, number], HYPE: [80, 0, 0] as [number, number, number] } },
    ],
  };

  test("move vs BTC at each horizon; a fade is sign-flipped; missing days stay ungraded", () => {
    const ride = landCalls([call()], [mk("BTC", 100), mk("HYPE", 90)], empty, "2026-10-30", AT).file;
    const fade = landCalls([call({ market: "MEGA", stance: "fade" })], [mk("BTC", 100), mk("MEGA", 2)], empty, "2026-10-30", AT).file;
    const g = gradeCalls({ calls: [...ride.calls, ...fade.calls] }, state);
    expect(g.calls[0]!.rel).toEqual({ "3": 0, "7": -11.11 }); // +3d: 99/90 vs 110/100 = flat; +7d: 80/90 vs 100/100
    expect(g.calls[1]!.rel).toEqual({}); // MEGA not in memory
  });

  test("a graded horizon is never overwritten", () => {
    const f: RadarCallsFile = { calls: [{ ...landCalls([call()], [mk("BTC", 100), mk("HYPE", 90)], empty, "2026-10-30", AT).landed[0]!, rel: { "3": 5 } }] };
    expect(gradeCalls(f, state).calls[0]!.rel["3"]).toBe(5);
  });

  test("scorecard summarises graded calls only", () => {
    expect(scorecard(empty)).toEqual(["no graded calls yet"]);
    const f: RadarCallsFile = { calls: [{ ...landCalls([call()], [mk("BTC", 100), mk("HYPE", 90)], empty, "2026-10-30", AT).landed[0]!, rel: { "3": 4, "7": -2 } }] };
    expect(scorecard(f)).toEqual(["ride +3d vs BTC: n=1 · mean +4.0% · 1/1 went the called way", "ride +7d vs BTC: n=1 · mean -2.0% · 0/1 went the called way"]);
  });
});
