import { describe, expect, test } from "bun:test";
import { RadarCallsInputSchema, type RadarCallInput, type RadarCallsFile, type RadarState } from "../../shared/radar.js";
import { checkKills, gradeCalls, landCalls, scorecard } from "./calls.js";
import type { RadarMarket } from "./scan.js";

const mk = (key: string, mark: number, o: Partial<RadarMarket> = {}): RadarMarket => ({ key, dex: "main", mark, chg24hPct: 1, vol24h: 1e7, oiUsd: 1e7, fundingApr: 11, premiumBps: 0, atCap: false, ...o });
const call = (o: Partial<RadarCallInput> = {}): RadarCallInput => ({
  market: "HYPE",
  stance: "ride",
  direction: "long",
  kind: "catalyst",
  thesis: "ICE strategic investment in Trade[XYZ]; HIP-3 deployers stake HYPE",
  cause_url: "https://ir.theice.com/press",
  cause_date: "2026-10-29",
  kill_price: 81,
  kill_if: "back inside the pre-news range",
  ...o,
});
const AT = "2026-10-30T07:41:00Z";
const empty: RadarCallsFile = { calls: [] };
const noState: RadarState = { days: [] };
const d = (date: string, marks: Record<string, number>): RadarState["days"][number] => ({ date, at: "", marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, [v, 0, 0] as [number, number, number]])) });
const scan = (hype: number) => [mk("BTC", 100), mk("HYPE", hype)];

describe("call input schema", () => {
  test("cause is required, dates must be real, at most 3 calls, watch is not a call", () => {
    expect(RadarCallsInputSchema.safeParse({ calls: [call()] }).success).toBe(true);
    expect(RadarCallsInputSchema.safeParse({ calls: [{ ...call(), cause_url: null }] }).success).toBe(false);
    expect(RadarCallsInputSchema.safeParse({ calls: [call({ cause_date: "2026-02-30" })] }).success).toBe(false);
    expect(RadarCallsInputSchema.safeParse({ calls: [call({ cause_url: "ftp://x.org/a" })] }).success).toBe(false);
    expect(RadarCallsInputSchema.safeParse({ calls: [{ ...call(), stance: "watch" }] }).success).toBe(false);
    expect(RadarCallsInputSchema.safeParse({ calls: [call(), call(), call(), call()] }).success).toBe(false);
  });
});

describe("landCalls", () => {
  test("stamps prices from the scan and writes the push line with code numbers", () => {
    const state: RadarState = { days: [d("2026-10-29", { BTC: 100, HYPE: 80 })] };
    const r = landCalls([call()], scan(90), state, empty, "2026-10-30", AT);
    expect(r.rejected).toEqual([]);
    const l = r.landed[0]!;
    expect(l.call).toMatchObject({ id: "2026-10-30-1-HYPE", mark: 90, btc: 100, rel: {}, killed_at: null });
    expect(l.riskPct).toBeCloseTo(10);
    expect(l.since).toEqual({ fromDate: "2026-10-29", pct: 12.5, vsBtcPct: 12.5 });
    expect(l.line).toContain("HYPE · ride long · catalyst · cause ir.theice.com 2026-10-29");
    expect(l.line).toContain("kill 81 (10.0% away)");
  });

  test("drops unknown markets, BTC, stale or far causes, a kill on the wrong side, and repeats", () => {
    const first = landCalls([call()], scan(90), noState, empty, "2026-10-30", AT);
    const r = landCalls(
      [
        call({ market: "NOPE" }),
        call({ market: "BTC", kill_price: 90 }),
        call({ cause_date: "2026-10-27" }),
        call({ cause_date: "2026-11-20" }),
        call({ direction: "short", kill_price: 80 }),
        call(),
        call({ direction: "short", stance: "fade", kill_price: 99 }),
      ],
      scan(95),
      noState,
      first.file,
      "2026-11-01",
      AT,
    );
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "not a live market in this scan",
      "calls are graded against BTC, so BTC itself cannot be called",
      "cause dated 2026-10-27 is outside 3 days back to 14 days ahead",
      "cause dated 2026-11-20 is outside 3 days back to 14 days ahead",
      "kill 80 is on the wrong side of the mark 95 for a short",
      "repeat of 2026-10-30-1-HYPE",
    ]);
    expect(r.landed.map((l) => [l.call.id, l.call.direction])).toEqual([["2026-11-01-1-HYPE", "short"]]);
  });

  test("a future event has no since-cause move", () => {
    const r = landCalls([call({ cause_date: "2026-11-06", stance: "fade", direction: "short", kill_price: 99 })], scan(90), { days: [d("2026-10-29", { BTC: 100, HYPE: 80 })] }, empty, "2026-11-02", AT);
    expect(r.landed[0]!.since).toBeNull();
  });
});

describe("gradeCalls, checkKills, scorecard", () => {
  const state: RadarState = { days: [d("2026-11-02", { BTC: 110, HYPE: 99, RUNE: 0.44 }), d("2026-11-06", { BTC: 100, HYPE: 80, RUNE: 0.4 })] };

  test("move vs BTC at each horizon, signed by direction, so a correct short scores positive", () => {
    const long = landCalls([call()], scan(90), noState, empty, "2026-10-30", AT).file;
    const short = landCalls([call({ market: "RUNE", direction: "short", kill_price: 0.6, stance: "ride" })], [mk("BTC", 100), mk("RUNE", 0.5)], noState, empty, "2026-10-30", AT).file;
    const g = gradeCalls({ calls: [...long.calls, ...short.calls] }, state);
    expect(g.calls[0]!.rel).toEqual({ "3": 0, "7": -11.11 }); // +3d: 99/90 vs 110/100 flat; +7d: 80/90 vs 100/100
    expect(g.calls[1]!.rel).toEqual({ "3": 20, "7": 20 }); // ride down: RUNE -20% vs BTC is a correct short
  });

  test("a graded horizon is never overwritten", () => {
    const f: RadarCallsFile = { calls: [{ ...landCalls([call()], scan(90), noState, empty, "2026-10-30", AT).landed[0]!.call, rel: { "3": 5 } }] };
    expect(gradeCalls(f, state).calls[0]!.rel["3"]).toBe(5);
  });

  test("a crossed kill level is reported once, and only within the watch window", () => {
    const f = landCalls([call()], scan(90), noState, empty, "2026-10-30", AT).file;
    const first = checkKills(f, scan(80), "2026-11-01");
    expect(first.killed).toHaveLength(1);
    expect(first.file.calls[0]!.killed_at).toBe("2026-11-01");
    expect(checkKills(first.file, scan(79), "2026-11-02").killed).toEqual([]);
    expect(checkKills(f, scan(85), "2026-11-01").killed).toEqual([]);
    expect(checkKills(f, scan(80), "2026-11-10").killed).toEqual([]);
  });

  test("scorecard summarises graded calls only", () => {
    expect(scorecard(empty)).toEqual(["no graded calls yet"]);
    const f: RadarCallsFile = { calls: [{ ...landCalls([call()], scan(90), noState, empty, "2026-10-30", AT).landed[0]!.call, rel: { "3": 4, "7": -2 } }] };
    expect(scorecard(f)).toEqual(["ride +3d vs BTC: n=1 · mean +4.0% · 1/1 went the called way", "ride +7d vs BTC: n=1 · mean -2.0% · 0/1 went the called way"]);
  });
});
