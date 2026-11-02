import { describe, expect, test } from "bun:test";
import type { Observation } from "../db.js";
import { collectFred, deriveHistory, deriveMetrics, FRED_HISTORY_DAYS, FRED_RECENT_DAYS, FRED_SERIES, type FredDbDeps } from "./fred.js";

describe("deriveMetrics", () => {
  test("computes net_liquidity in billions and the 2s10s spread", () => {
    const derived = deriveMetrics({
      WALCL: { value: 6_500_000, date: "2026-08-25" }, // millions
      RRPONTSYD: { value: 200, date: "2026-08-25" }, // billions
      WTREGEN: { value: 700_000, date: "2026-08-25" }, // millions
      DGS2: { value: 3.6, date: "2026-08-25" },
      DGS10: { value: 4.2, date: "2026-08-25" },
    });
    expect(derived.net_liquidity!.value).toBeCloseTo(6500 - 200 - 700, 6);
    expect(derived.spread_2s10s!.value).toBeCloseTo(0.6, 6);
  });

  test("omits a derived metric when its inputs are incomplete", () => {
    expect(deriveMetrics({ WALCL: { value: 1, date: "2026-08-25" } })).toEqual({});
  });
});

describe("deriveHistory", () => {
  test("net liquidity on each WALCL Wednesday with the RRP print on or before it; spread on shared dates", () => {
    const h = deriveHistory({
      WALCL: [
        { date: "2026-10-21", value: 6_750_000 },
        { date: "2026-10-28", value: 6_745_635 },
      ],
      WTREGEN: [
        { date: "2026-10-21", value: 950_000 },
        { date: "2026-10-28", value: 999_727 },
      ],
      RRPONTSYD: [
        { date: "2026-10-20", value: 5 },
        { date: "2026-10-27", value: 4 },
        { date: "2026-10-30", value: 9 }, // after the last Wednesday: not used
      ],
      DGS2: [{ date: "2026-10-29", value: 4.61 }],
      DGS10: [
        { date: "2026-10-28", value: 4.96 },
        { date: "2026-10-29", value: 4.98 },
      ],
    });
    expect(h.net_liquidity!.map((p) => [p.date, Math.round(p.value * 1000) / 1000])).toEqual([
      ["2026-10-21", 6750 - 950 - 5],
      ["2026-10-28", 6745.635 - 999.727 - 4],
    ]);
    expect(h.spread_2s10s!.map((p) => [p.date, Math.round(p.value * 100) / 100])).toEqual([["2026-10-29", 0.37]]);
  });
});

const NOW = Date.parse("2026-11-02T08:00:00Z");
const csv = (id: string, rows: [string, string][]) => `observation_date,${id}\n${rows.map((r) => r.join(",")).join("\n")}\n`;

function fakeFetch(fail: Set<string> = new Set()) {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const id = new URL(url).searchParams.get("id")!;
    if (fail.has(id)) return new Response("nope", { status: 500 });
    const rows: [string, string][] =
      id === "WALCL" ? [["2026-10-28", "6745635"]] : id === "WTREGEN" ? [["2026-10-28", "999727"]] : id === "RRPONTSYD" ? [["2026-10-28", "0.2"]] : [["2026-10-29", "4.5"], ["2026-10-30", ""]];
    return new Response(csv(id, rows), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

function deps(last: Date | null) {
  const written: Observation[] = [];
  const runs: unknown[][] = [];
  const d: FredDbDeps = {
    ensureSeries: async () => {},
    upsertObservations: async (rows) => (written.push(...rows), rows.length),
    recordCollectorRun: async (...args) => void runs.push(args),
    lastFetch: async () => last,
    now: () => NOW,
  };
  return { d, written, runs };
}

const cosd = (urls: string[]) => new Set(urls.map((u) => new URL(u).searchParams.get("cosd")));
const dayBefore = (days: number) => new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);

describe("collectFred", () => {
  test("keyless: a first run backfills the full history window and stores every point plus derived series", async () => {
    const { f, urls } = fakeFetch();
    const { d, written, runs } = deps(null);
    const r = await collectFred(f, d);
    expect(r.ok).toBe(true);
    expect(urls).toHaveLength(FRED_SERIES.length);
    expect(urls.every((u) => u.startsWith("https://fred.stlouisfed.org/graph/fredgraph.csv?id="))).toBe(true);
    expect(cosd(urls)).toEqual(new Set([dayBefore(FRED_HISTORY_DAYS)]));
    const ids = new Set(written.map((o) => o.seriesId));
    expect(ids.has("fred.net_liquidity")).toBe(true);
    expect(ids.has("fred.DGS10")).toBe(true);
    expect(written.find((o) => o.seriesId === "fred.net_liquidity")!.value).toBeCloseTo(6745.635 - 999.727 - 0.2, 6);
    expect(written.some((o) => o.seriesId === "fred.DGS10" && new Date(o.ts).toISOString().startsWith("2026-10-30"))).toBe(false); // empty value skipped
    expect(runs).toEqual([["fred", new Date(NOW), true, null]]);
  });

  test("a recent fetch reads only the short window; one inside the interval is skipped and not recorded", async () => {
    const recent = fakeFetch();
    await collectFred(recent.f, deps(new Date(NOW - 24 * 3_600_000)).d);
    expect(cosd(recent.urls)).toEqual(new Set([dayBefore(FRED_RECENT_DAYS)]));

    const skipped = fakeFetch();
    const s = deps(new Date(NOW - 2 * 3_600_000));
    expect(await collectFred(skipped.f, s.d)).toEqual({ ok: true, error: "skipped:throttled", written: 0 });
    expect(skipped.urls).toEqual([]);
    expect(s.runs).toEqual([]);
  });

  test("one failing series keeps the rest and is reported; all failing is a failed run", async () => {
    const one = fakeFetch(new Set(["SOFR"]));
    const a = deps(null);
    const r = await collectFred(one.f, a.d);
    expect(r.ok).toBe(true);
    expect(r.error).toStartWith("FRED SOFR:");
    expect(a.written.some((o) => o.seriesId === "fred.SOFR")).toBe(false);
    expect(a.written.some((o) => o.seriesId === "fred.DGS2")).toBe(true);

    const all = fakeFetch(new Set(FRED_SERIES));
    const b = deps(null);
    const r2 = await collectFred(all.f, b.d);
    expect(r2.ok).toBe(false);
    expect(b.written).toEqual([]);
    expect(b.runs[0]![2]).toBe(false);
  });
});
