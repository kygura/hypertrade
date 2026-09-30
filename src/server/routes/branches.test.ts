import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { branchesRoutes } from "./branches.js";

const app = new Hono().route("/branches", branchesRoutes);

const validConfig = {
  startDate: "2024-01-01",
  initialCapitalUsd: 1000,
  allocations: [{ coin: "BTC", weightPct: 100 }],
  rebalance: "none",
};

describe("POST /branches", () => {
  test("400s with 'invalid body' when a top-level field is missing", async () => {
    const res = await app.request("/branches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: validConfig }), // missing name
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid body");
  });

  test("400s with 'invalid config' when only the nested config is malformed", async () => {
    const res = await app.request("/branches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", config: { ...validConfig, startDate: "not-a-date" } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid config");
  });
});
