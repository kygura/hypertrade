import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { failure } from "./http.js";

const app = (err: unknown) => new Hono().get("/x", (c) => failure(c, err, "test", "x unavailable"));

describe("failure", () => {
  test("a missing database is a 503 with the stated reason, not the route's generic text", async () => {
    const res = await app(new Error("DATABASE_URL is not set — database queries are unavailable")).request("/x");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "DATABASE_URL is not set — database queries are unavailable" });
  });

  test("any other error stays a 500 with the generic text", async () => {
    const orig = console.error;
    console.error = () => {};
    try {
      const res = await app(new Error("select * from secret")).request("/x");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "x unavailable" });
    } finally {
      console.error = orig;
    }
  });
});
