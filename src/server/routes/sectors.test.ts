import { describe, expect, test } from "bun:test";
import { SectorsDataSchema } from "../../shared/schemas.js";
import latest from "../../../data/sectors/latest.json" with { type: "json" };
import { SECTORS_HISTORY } from "../../../data/sectors/index.js";
import { enrichSector, getSectorsPayload, SOCIAL_MAX_AGE_MS, socialFromObservations, type TokenSocial } from "./sectors.js";
import type { AssetCtx } from "../../shared/types.js";

function ctx(name: string, openInterest: number, markPx: number, funding: number): AssetCtx {
  return {
    name,
    szDecimals: 2,
    markPx,
    oraclePx: markPx,
    midPx: markPx,
    dayNtlVlm: 0,
    prevDayPx: markPx,
    openInterest,
    funding,
    premium: 0,
    dayChange: 0,
    isDelisted: false,
  };
}

describe("seed data", () => {
  test("latest.json parses against SectorsDataSchema", () => {
    expect(() => SectorsDataSchema.parse(latest)).not.toThrow();
  });

  test("latest.json matches the newest dated snapshot", () => {
    const newest = [...SECTORS_HISTORY].sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1)!;
    expect(SectorsDataSchema.parse(latest)).toEqual(SectorsDataSchema.parse(newest.data));
  });
});

describe("enrichSector", () => {
  const ctxs = [ctx("BTC", 100, 60_000, 0.0001), ctx("ETH", 200, 3_000, 0.0002)];

  test("sums OI in USD and averages funding across matched tokens", () => {
    const result = enrichSector(["BTC", "ETH"], ctxs);
    expect(result.oi_usd_total).toBe(100 * 60_000 + 200 * 3_000);
    expect(result.avg_funding).toBeCloseTo(0.00015, 10);
    expect(result.names_matched).toBe(2);
  });

  test("skips unmatched tokens silently", () => {
    const result = enrichSector(["BTC", "NOTLISTED"], ctxs);
    expect(result.names_matched).toBe(1);
    expect(result.oi_usd_total).toBe(100 * 60_000);
  });

  test("returns zeros when nothing matches", () => {
    expect(enrichSector(["NOPE"], ctxs)).toEqual({
      oi_usd_total: 0,
      avg_funding: 0,
      names_matched: 0,
      tokenRows: [],
      social_mentions_24h: null,
      social_share_24h: null,
      social_as_of: null,
    });
  });

  test("returns a per-matched-token row for the sector drill-in table", () => {
    const result = enrichSector(["BTC", "ETH", "NOTLISTED"], ctxs);
    expect(result.tokenRows).toEqual([
      { coin: "BTC", markPx: 60_000, dayChangePct: 0, openInterestUsd: 100 * 60_000, funding: 0.0001 },
      { coin: "ETH", markPx: 3_000, dayChangePct: 0, openInterestUsd: 200 * 3_000, funding: 0.0002 },
    ]);
  });
});

describe("social enrichment", () => {
  const ctxs = [ctx("BTC", 100, 60_000, 0.0001), ctx("ETH", 200, 3_000, 0.0002), ctx("SOL", 50, 150, 0)];
  const at = new Date("2026-10-06T12:00:00Z");
  const social = new Map<string, TokenSocial>([
    ["BTC", { mentions24h: 4200, share24h: 0.3, mentionsChg24h: 0.2, ts: at }],
    ["ETH", { mentions24h: 1000, share24h: 0.1, ts: new Date(at.getTime() - 3_600_000) }],
  ]);

  test("sums mentions and share over sampled tokens and stamps the oldest sample", () => {
    const result = enrichSector(["BTC", "ETH", "SOL"], ctxs, social);
    expect(result.social_mentions_24h).toBe(5200);
    expect(result.social_share_24h).toBeCloseTo(0.4, 10);
    expect(result.social_as_of).toBe("2026-10-06T11:00:00.000Z");
    expect(result.tokenRows.find((r) => r.coin === "BTC")).toMatchObject({ mentions24h: 4200, share24h: 0.3, mentionsChg24h: 0.2 });
    expect(result.tokenRows.find((r) => r.coin === "ETH")?.mentionsChg24h).toBeUndefined();
    expect(result.tokenRows.find((r) => r.coin === "SOL")?.mentions24h).toBeUndefined();
  });

  test("socialFromObservations drops stale samples and mismatched change points", () => {
    const now = at.getTime();
    const old = new Date(now - SOCIAL_MAX_AGE_MS - 1);
    const earlier = new Date(now - 8 * 3_600_000);
    const map = socialFromObservations(
      [
        { seriesId: "elfa.mentions_24h.BTC", ts: at, value: 4200 },
        { seriesId: "elfa.share_24h.BTC", ts: at, value: 0.3 },
        { seriesId: "elfa.mentions_chg_24h.BTC", ts: earlier, value: 0.9 },
        { seriesId: "elfa.mentions_24h.kPEPE", ts: old, value: 900 },
        { seriesId: "elfa.share_24h.kPEPE", ts: old, value: 0.06 },
        { seriesId: "elfa.mentions_24h.ETH", ts: at, value: 10 },
      ],
      now,
    );
    expect([...map.keys()]).toEqual(["BTC"]);
    expect(map.get("BTC")?.mentionsChg24h).toBeUndefined();
  });

  test("the payload still renders when social data is unavailable", async () => {
    const payload = await getSectorsPayload({ ctxs: async () => ctxs, social: async () => new Map() });
    expect(payload.sectors.length).toBeGreaterThan(0);
    for (const s of payload.sectors) expect(s.social_share_24h).toBeNull();
  });

  test("the payload passes every sector token to the social loader once", async () => {
    let asked: string[] = [];
    await getSectorsPayload({
      ctxs: async () => ctxs,
      social: async (coins) => {
        asked = coins;
        return new Map();
      },
    });
    expect(asked.length).toBe(new Set(asked).size);
    expect(asked).toContain("FET");
  });
});
