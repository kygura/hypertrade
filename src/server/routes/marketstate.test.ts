import { describe, expect, test } from "bun:test";
import { MarketStateDataSchema } from "../../shared/schemas.js";
import latest from "../../../data/marketstate/latest.json" with { type: "json" };
import { MARKETSTATE_HISTORY } from "../../../data/marketstate/index.js";
import { marketstateRoutes } from "./marketstate.js";

const newest = [...MARKETSTATE_HISTORY].sort((a, b) => (a.date < b.date ? -1 : 1)).at(-1)!;

describe("seed data", () => {
  test("latest.json parses against MarketStateDataSchema", () => {
    expect(() => MarketStateDataSchema.parse(latest)).not.toThrow();
  });

  test("latest.json matches the newest dated snapshot", () => {
    expect(MarketStateDataSchema.parse(latest)).toEqual(MarketStateDataSchema.parse(newest.data));
  });
});

describe("GET /", () => {
  test("returns the parsed briefing plus history dates", async () => {
    const res = await marketstateRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headline).toBe(latest.headline);
    expect(body.history).toContain(newest.date);
  });
});

describe("GET /history/:date", () => {
  test("returns a known dated snapshot", async () => {
    const res = await marketstateRoutes.request(`/history/${newest.date}`);
    expect(res.status).toBe(200);
    expect((await res.json()).headline).toBe(latest.headline);
  });

  test("404s an unknown date", async () => {
    const res = await marketstateRoutes.request("/history/2020-01-01");
    expect(res.status).toBe(404);
  });
});
