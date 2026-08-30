import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { candlesRoutes } from "./candles";

const app = new Hono().route("/candles", candlesRoutes);

describe("GET /candles/:coin", () => {
  test("400s on an unsupported tf", async () => {
    const res = await app.request("/candles/BTC?tf=3d");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid query" });
  });

  test("400s on an unparseable from date", async () => {
    const res = await app.request("/candles/BTC?from=not-a-date");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid query" });
  });
});
