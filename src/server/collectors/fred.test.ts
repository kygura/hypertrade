import { describe, expect, test } from "bun:test";
import fixture from "../../shared/fixtures/fred-observations.json" with { type: "json" };
import { collectFred, deriveMetrics, parseFredObservations } from "./fred.js";

describe("parseFredObservations", () => {
  test("skips the '.' (missing) observation and returns the latest valid one", () => {
    expect(parseFredObservations(fixture)).toEqual({ value: 6500000, date: "2026-08-25" });
  });

  test("returns null when every observation is missing", () => {
    expect(parseFredObservations({ observations: [{ date: "2026-08-25", value: "." }] })).toBeNull();
  });
});

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

describe("collectFred", () => {
  test("degrades to skipped:no-key when FRED_API_KEY is unset, without calling fetch or a live DB", async () => {
    const key = process.env.FRED_API_KEY;
    delete process.env.FRED_API_KEY;
    const fetchFn = (() => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const recorded: unknown[] = [];
    const deps = {
      ensureSeries: async () => {
        throw new Error("must not be called");
      },
      upsertObservations: async () => {
        throw new Error("must not be called");
      },
      recordCollectorRun: async (...args: unknown[]) => {
        recorded.push(args);
      },
    };
    try {
      expect(await collectFred(fetchFn, deps)).toEqual({ ok: true, error: "skipped:no-key", written: 0 });
      expect(recorded).toEqual([["fred", expect.any(Date), true, "skipped:no-key"]]);
    } finally {
      if (key) process.env.FRED_API_KEY = key;
    }
  });
});
