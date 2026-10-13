import { describe, expect, test } from "bun:test";
import type { OrderIntent } from "../../../shared/intel.js";
import { makeService } from "../../desk/testkit.js";
import { createOrderRoutes } from "./order.js";

const intent: OrderIntent = { asset: "ETH", side: "long", leverage: 3, size: { usd: 800 }, entry: { type: "market" }, stop: { type: "pct", pct: 5 } };

function app() {
  const kit = makeService();
  const routes = createOrderRoutes({ llm: { makeProvider: () => null, cache: { cacheGet: async () => null, cachePut: async () => {}, callsSince: async () => 0 }, now: () => new Date(), dailyCap: 10 }, desk: kit.service });
  const post = (path: string, body: unknown) => routes.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...kit, post };
}

describe("order routes", () => {
  test("preview {intent} then confirm {intent, previewHash} executes on paper", async () => {
    const { post, store } = app();
    const pv = await post("/order/preview", { intent });
    expect(pv.status).toBe(200);
    const preview = (await pv.json()) as { previewHash: string; venue: string; verdict: { decision: string } };
    expect(preview).toMatchObject({ venue: "paper", verdict: { decision: "approve" } });
    expect(await store.listFills(10)).toHaveLength(0);

    const res = await post("/order/confirm", { intent, previewHash: preview.previewHash });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "executed" });
    expect(await store.listFills(10)).toHaveLength(1);

    const again = await post("/order/confirm", { intent, previewHash: preview.previewHash });
    expect(again.status).toBe(409);
  });

  test("400 with the field on a malformed body", async () => {
    const { post } = app();
    const bad = await post("/order/preview", { intent: { ...intent, leverage: 99 } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: expect.any(String), field: expect.any(String) });
    expect((await post("/order/confirm", { intent })).status).toBe(400);
    expect((await post("/order/preview", { text: "x".repeat(501) })).status).toBe(400);
  });

  test("400 on a resolution error, with the intent field", async () => {
    const { post } = app();
    const res = await post("/order/preview", { intent: { ...intent, stop: { type: "price", px: 4100 } } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "intent.stop" });
  });

  test("confirm without a preview → 409; text without a provider → 503", async () => {
    const { post, store } = app();
    expect((await post("/order/confirm", { intent, previewHash: "f".repeat(64) })).status).toBe(409);
    expect(await store.listFills(10)).toHaveLength(0);
    expect((await post("/order/preview", { text: "long eth 3x 800" })).status).toBe(503);
  });

  test("unexpected errors → generic 500, detail only in the log", async () => {
    const routes = createOrderRoutes(() => {
      throw new Error("relation desk_fills: password=hunter2");
    });
    const orig = console.error;
    console.error = () => {};
    try {
      const res = await routes.request("/order/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent }) });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "order error" });
    } finally {
      console.error = orig;
    }
  });
});
