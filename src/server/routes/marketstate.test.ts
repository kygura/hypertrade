import { describe, expect, test } from "bun:test";
import { MarketStateDataSchema } from "../../shared/schemas";
import latest from "../../../data/marketstate/latest.json";
import dated from "../../../data/marketstate/2026-08-30.json";
import { marketstateRoutes } from "./marketstate";

describe("seed data", () => {
  test("latest.json parses against MarketStateDataSchema", () => {
    expect(() => MarketStateDataSchema.parse(latest)).not.toThrow();
  });

  test("dated copy matches latest.json", () => {
    expect(dated).toEqual(latest);
  });
});

describe("GET /", () => {
  test("returns the parsed briefing plus history dates", async () => {
    const res = await marketstateRoutes.request("/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.headline).toBe(latest.headline);
    expect(body.history).toEqual(["2026-08-30"]);
  });
});

describe("GET /history/:date", () => {
  test("returns a known dated snapshot", async () => {
    const res = await marketstateRoutes.request("/history/2026-08-30");
    expect(res.status).toBe(200);
    expect((await res.json()).headline).toBe(latest.headline);
  });

  test("404s an unknown date", async () => {
    const res = await marketstateRoutes.request("/history/2020-01-01");
    expect(res.status).toBe(404);
  });
});
