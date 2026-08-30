import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { cronRoutes } from "./cron";

process.env.CRON_TOKEN = "test-cron-token";

const app = new Hono().route("/cron", cronRoutes);

describe("POST /cron/collect", () => {
  test("401s without a valid x-cron-token (does not run any collector)", async () => {
    const res = await app.request("/cron/collect", { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("401s with a wrong token", async () => {
    const res = await app.request("/cron/collect", {
      method: "POST",
      headers: { "x-cron-token": "wrong" },
    });
    expect(res.status).toBe(401);
  });
});
