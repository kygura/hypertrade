import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { metricsRoutes } from "./metrics.js";

const app = new Hono().route("/metrics", metricsRoutes);

describe("GET /metrics/summary", () => {
  test("400s when ids is missing", async () => {
    const res = await app.request("/metrics/summary");
    expect(res.status).toBe(400);
  });

  test("400s when ids is empty", async () => {
    const res = await app.request("/metrics/summary?ids=");
    expect(res.status).toBe(400);
  });
});

describe("GET /metrics/series/:id", () => {
  test("400s on a non-numeric buckets param", async () => {
    const res = await app.request("/metrics/series/hl.total_oi_usd?buckets=abc");
    expect(res.status).toBe(400);
  });

  test("400s on a non-positive buckets param", async () => {
    const res = await app.request("/metrics/series/hl.total_oi_usd?buckets=0");
    expect(res.status).toBe(400);
  });
});
