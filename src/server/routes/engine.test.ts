import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { engineRoutes } from "./engine";
import governor from "../../shared/fixtures/strategy/governor.json";
import strategyStatus from "../../shared/fixtures/strategy/strategy-status.json";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.ENGINE_URL;
const originalToken = process.env.ENGINE_TOKEN;

interface Captured {
  url: string;
  init: RequestInit;
}

function captureFetch(respond: () => Response | Promise<Response>): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.ENGINE_URL = "http://core.internal:8080";
  process.env.ENGINE_TOKEN = "core-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.ENGINE_URL;
  else process.env.ENGINE_URL = originalUrl;
  if (originalToken === undefined) delete process.env.ENGINE_TOKEN;
  else process.env.ENGINE_TOKEN = originalToken;
});

describe("/engine proxy", () => {
  test("503 engine not configured when ENGINE_URL is unset", async () => {
    delete process.env.ENGINE_URL;
    const { calls } = captureFetch(() => jsonResponse({}));
    const res = await engineRoutes.request("/governor");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "engine not configured" });
    expect(calls.length).toBe(0);
  });

  test("GET passes through path, query string, bearer token and body", async () => {
    const { calls } = captureFetch(() => jsonResponse({ decisions: [] }));
    const res = await engineRoutes.request("/decisions?limit=5&strategy=funding_skew");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decisions: [] });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://core.internal:8080/api/strategy/decisions?limit=5&strategy=funding_skew");
    expect(calls[0]!.init.method).toBe("GET");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer core-token");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  test("omits the Authorization header when ENGINE_TOKEN is unset", async () => {
    delete process.env.ENGINE_TOKEN;
    const { calls } = captureFetch(() => jsonResponse(governor));
    await engineRoutes.request("/governor");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  test("PUT forwards the JSON body verbatim and returns the upstream body", async () => {
    const { calls } = captureFetch(() => jsonResponse(strategyStatus));
    const config = strategyStatus.config;
    const res = await engineRoutes.request("/configs/funding_skew", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).config.id).toBe("funding_skew");
    expect(calls[0]!.url).toBe("http://core.internal:8080/api/strategy/configs/funding_skew");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(config);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  test("POST without a body sends no body", async () => {
    const { calls } = captureFetch(() => jsonResponse({ ...governor, killed: true }));
    const res = await engineRoutes.request("/kill", { method: "POST" });
    expect((await res.json()).killed).toBe(true);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  test("upstream error status and {error, field} body pass through", async () => {
    captureFetch(() => jsonResponse({ error: "size_usd must be ≥ 10", field: "params.size_usd" }, 400));
    const res = await engineRoutes.request("/configs/funding_skew", { method: "PUT", body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "size_usd must be ≥ 10", field: "params.size_usd" });
  });

  test("non-JSON upstream body is wrapped as {error}", async () => {
    captureFetch(() => new Response("bad gateway", { status: 502 }));
    const res = await engineRoutes.request("/venues");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "bad gateway" });
  });

  test("502 engine unreachable when fetch rejects", async () => {
    captureFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await engineRoutes.request("/governor");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "engine unreachable" });
  });

  test("502 engine timeout when the upstream fetch times out", async () => {
    captureFetch(() => {
      const err = new Error("The operation timed out");
      err.name = "TimeoutError";
      throw err;
    });
    const res = await engineRoutes.request("/governor");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "engine timeout" });
  });

  test("strips the /api/engine mount prefix when mounted under the app", async () => {
    const { calls } = captureFetch(() => jsonResponse({ venues: [] }));
    const app = new Hono().basePath("/api").route("/engine", engineRoutes);
    const res = await app.request("/api/engine/venues");
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("http://core.internal:8080/api/strategy/venues");
  });
});
