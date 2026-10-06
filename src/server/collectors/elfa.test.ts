import { describe, expect, test } from "bun:test";
import fixture from "../../shared/fixtures/elfa-trending-tokens.json" with { type: "json" };
import type { Observation } from "../db.js";
import { buildElfaObservations, collectElfa, hlSymbolFor, intervalHours, parseElfaTrending, type ElfaDeps } from "./elfa.js";

const UNIVERSE = new Set(["BTC", "HYPE", "kPEPE", "VIRTUAL", "ETH"]);
const TS = new Date("2026-10-06T12:00:00Z");

describe("hlSymbolFor", () => {
  test("uppercases, strips a $ and maps 1000x memes to their k-symbol", () => {
    expect(hlSymbolFor("btc", UNIVERSE)).toBe("BTC");
    expect(hlSymbolFor("$hype", UNIVERSE)).toBe("HYPE");
    expect(hlSymbolFor("pepe", UNIVERSE)).toBe("kPEPE");
  });

  test("null for unlisted or non-ticker strings", () => {
    expect(hlSymbolFor("notonhl", UNIVERSE)).toBeNull();
    expect(hlSymbolFor("bad ticker!", UNIVERSE)).toBeNull();
    expect(hlSymbolFor("", UNIVERSE)).toBeNull();
  });
});

describe("parseElfaTrending", () => {
  test("reads the documented envelope and tolerates extra fields", () => {
    const rows = parseElfaTrending(fixture);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ token: "btc", current: 4200, previous: 3500 });
  });

  test("throws on a body without the data array", () => {
    expect(() => parseElfaTrending({ success: false })).toThrow();
  });
});

describe("buildElfaObservations", () => {
  const built = buildElfaObservations(parseElfaTrending(fixture), UNIVERSE, TS);
  const value = (id: string) => built.observations.find((o) => o.seriesId === id)?.value;

  test("share is over every trending token, listed or not", () => {
    const total = 4200 + 1800 + 900 + 700 + 300 + 100;
    expect(value("elfa.mentions_24h_total")).toBe(total);
    expect(value("elfa.share_24h.BTC")).toBeCloseTo(4200 / total, 10);
    expect(value("elfa.mentions_24h.kPEPE")).toBe(900);
  });

  test("change is a fraction from the counts; no prior count means no change point", () => {
    expect(value("elfa.mentions_chg_24h.BTC")).toBeCloseTo(0.2, 10);
    expect(value("elfa.mentions_chg_24h.HYPE")).toBeCloseTo(-0.25, 10);
    expect(value("elfa.mentions_chg_24h.VIRTUAL")).toBeUndefined();
    expect(value("elfa.mentions_24h.VIRTUAL")).toBe(300);
  });

  test("only HL-listed coins get per-coin series; every observation has a series def", () => {
    expect(built.matched).toBe(4);
    const ids = new Set(built.seriesDefs.map((d) => d.id));
    for (const o of built.observations) expect(ids.has(o.seriesId)).toBe(true);
    expect([...ids].some((id) => id.includes("NOTONHL"))).toBe(false);
  });

  test("two tickers on one coin are summed", () => {
    const merged = buildElfaObservations(
      [
        { token: "pepe", current: 10, previous: 5 },
        { token: "kpepe", current: 2, previous: 1 },
      ],
      UNIVERSE,
      TS,
    );
    const v = (id: string) => merged.observations.find((o) => o.seriesId === id)?.value;
    expect(v("elfa.mentions_24h.kPEPE")).toBe(12);
    expect(v("elfa.mentions_chg_24h.kPEPE")).toBeCloseTo(1, 10);
  });
});

describe("intervalHours", () => {
  test("defaults to 8 and accepts 0", () => {
    expect(intervalHours({})).toBe(8);
    expect(intervalHours({ ELFA_MIN_INTERVAL_HOURS: "0" })).toBe(0);
    expect(intervalHours({ ELFA_MIN_INTERVAL_HOURS: "nope" })).toBe(8);
  });
});

describe("collectElfa orchestration", () => {
  const NOW = TS.getTime();
  function harness(opts: { last?: Date | null; universeFails?: boolean; status?: number } = {}) {
    const written: Observation[] = [];
    const runs: { ok: boolean; error: string | null | undefined }[] = [];
    const calls: string[] = [];
    const deps: ElfaDeps = {
      ensureSeries: async () => {},
      upsertObservations: async (rows) => {
        written.push(...rows);
        return rows.length;
      },
      recordCollectorRun: async (_c, _s, ok, error) => {
        runs.push({ ok, error });
      },
      lastFetch: async () => opts.last ?? null,
      universe: async () => {
        calls.push("universe");
        if (opts.universeFails) throw new Error("hl down");
        return [...UNIVERSE];
      },
      now: () => NOW,
    };
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      expect((init?.headers as Record<string, string>)["x-elfa-api-key"]).toBe("elfa_test");
      return new Response(JSON.stringify(fixture), { status: opts.status ?? 200 });
    }) as typeof fetch;
    return { deps, fetchFn, written, runs, calls };
  }
  const env = { ELFA_API_KEY: "elfa_test" };

  test("no key: recorded as skipped:no-key, nothing fetched", async () => {
    const h = harness();
    expect(await collectElfa(h.fetchFn, h.deps, {})).toEqual({ ok: true, error: "skipped:no-key", written: 0 });
    expect(h.calls).toEqual([]);
    expect(h.runs).toEqual([{ ok: true, error: "skipped:no-key" }]);
  });

  test("inside the interval: skipped, and not recorded", async () => {
    const h = harness({ last: new Date(NOW - 7 * 3_600_000) });
    expect((await collectElfa(h.fetchFn, h.deps, env)).error).toBe("skipped:throttled");
    expect(h.calls).toEqual([]);
    expect(h.runs).toEqual([]);
  });

  test("a run a few minutes early still fetches", async () => {
    const h = harness({ last: new Date(NOW - (8 * 60 - 5) * 60_000) });
    const result = await collectElfa(h.fetchFn, h.deps, env);
    expect(result.ok).toBe(true);
    expect(result.written).toBeGreaterThan(0);
    expect(h.calls[1]).toContain("/v2/aggregations/trending-tokens?timeWindow=24h");
    expect(h.runs).toEqual([{ ok: true, error: null }]);
  });

  test("HL down: fails before spending an Elfa credit", async () => {
    const h = harness({ universeFails: true });
    const result = await collectElfa(h.fetchFn, h.deps, env);
    expect(result).toEqual({ ok: false, error: "hl down", written: 0 });
    expect(h.calls).toEqual(["universe"]);
    expect(h.runs).toEqual([{ ok: false, error: "hl down" }]);
  });

  test("an Elfa error is a failed run, so the next cron retries", async () => {
    const h = harness({ status: 401 });
    const result = await collectElfa(h.fetchFn, h.deps, env);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
    expect(h.written).toEqual([]);
  });
});
