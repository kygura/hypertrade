import { afterEach, describe, expect, test } from "bun:test";
import { routinesRoutes } from "./routines";

const originalFetch = globalThis.fetch;
const originalWebhook = process.env.ROUTINE_WEBHOOK_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebhook === undefined) delete process.env.ROUTINE_WEBHOOK_URL;
  else process.env.ROUTINE_WEBHOOK_URL = originalWebhook;
});

describe("POST /trigger", () => {
  test("reports not-triggered when ROUTINE_WEBHOOK_URL is unset", async () => {
    delete process.env.ROUTINE_WEBHOOK_URL;
    const res = await routinesRoutes.request("/trigger", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.triggered).toBe(false);
    expect(body.last_trigger.error).toMatch(/ROUTINE_WEBHOOK_URL/);
  });

  test("posts to the webhook and reports success", async () => {
    process.env.ROUTINE_WEBHOOK_URL = "https://example.com/hook";
    let calledWith: [string, RequestInit] | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calledWith = [url, init];
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const res = await routinesRoutes.request("/trigger", { method: "POST" });
    const body = await res.json();
    expect(body.triggered).toBe(true);
    expect(calledWith![0]).toBe("https://example.com/hook");
    const sent = JSON.parse((calledWith![1] as RequestInit).body as string);
    expect(sent.source).toBe("hypertrade");
  });

  test("reports failure on a non-2xx webhook response", async () => {
    process.env.ROUTINE_WEBHOOK_URL = "https://example.com/hook";
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    const res = await routinesRoutes.request("/trigger", { method: "POST" });
    const body = await res.json();
    expect(body.triggered).toBe(false);
    expect(body.last_trigger.error).toBe("HTTP 500");
  });

  test("reports failure when the webhook fetch throws", async () => {
    process.env.ROUTINE_WEBHOOK_URL = "https://example.com/hook";
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const res = await routinesRoutes.request("/trigger", { method: "POST" });
    const body = await res.json();
    expect(body.triggered).toBe(false);
    expect(body.last_trigger.error).toBe("network down");
  });

  test("always returns last-trigger info, even before any call", async () => {
    delete process.env.ROUTINE_WEBHOOK_URL;
    const res = await routinesRoutes.request("/trigger", { method: "POST" });
    const body = await res.json();
    expect(body.last_trigger.requested_at).toBeString();
  });
});
