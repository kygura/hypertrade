import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import * as db from "../db.js";
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

describe("POST /branches/:id/run", () => {
  afterEach(() => {
    spy.mockRestore();
  });
  let spy: ReturnType<typeof spyOn>;

  test("422s instead of 500 when the stored config fails the current schema", async () => {
    spy = spyOn(db, "getBranch").mockResolvedValue({ id: "b1", name: "old", config: { ...validConfig, allocations: Array(11).fill({ coin: "BTC", weightPct: 1 }) } } as never);
    const res = await app.request("/branches/b1/run", { method: "POST" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("stored config is invalid");
  });
});
