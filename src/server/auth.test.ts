import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { app } from "../../api/index.js";
import { login, requireAuth, signSession, verifySession } from "./auth.js";

// Read at call time by auth.ts, so setting them after import is safe.
process.env.SESSION_SECRET = "test-session-secret";
process.env.APP_PASSWORD = "correct-horse";
process.env.CRON_TOKEN = "cron-token-abc";

/** Mirrors api/index.ts wiring, plus routes that do not exist there yet. */
const testApp = new Hono({ strict: false }).basePath("/api");
testApp.use("*", requireAuth);
testApp.get("/health", (c) => c.json({ ok: true }));
testApp.get("/branches", (c) => c.json({ protected: true }));
testApp.post("/cron/collect", (c) => c.json({ collected: true }));

describe("session token", () => {
  test("signs and verifies a roundtrip", () => {
    const token = signSession();
    expect(token).toBeString();
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);
    expect(verifySession(token)).toBe(true);
  });

  test("rejects a tampered signature", () => {
    const token = signSession()!;
    const [exp, sig] = token.split(".");
    expect(verifySession(`${exp}.${sig.slice(0, -1)}X`)).toBe(false);
  });

  test("rejects a tampered expiry (signature no longer matches)", () => {
    const token = signSession()!;
    const sig = token.split(".")[1];
    expect(verifySession(`${Date.now() + 9_000_000}.${sig}`)).toBe(false);
  });

  test("rejects an expired token even with a valid signature", () => {
    const expired = signSession(Date.now() - 1000)!;
    expect(verifySession(expired)).toBe(false);
  });

  test("rejects malformed and empty tokens", () => {
    for (const bad of ["", "nodot", ".sig", "abc.sig", undefined]) {
      expect(verifySession(bad)).toBe(false);
    }
  });

  test("fails closed when SESSION_SECRET is unset", () => {
    const token = signSession()!;
    const secret = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      expect(signSession()).toBeNull();
      expect(verifySession(token)).toBe(false);
    } finally {
      process.env.SESSION_SECRET = secret;
    }
  });
});

describe("login()", () => {
  test("accepts the configured password and rejects others", () => {
    expect(login("correct-horse")).toBe(true);
    expect(login("wrong")).toBe(false);
    expect(login("")).toBe(false);
  });

  test("fails closed when APP_PASSWORD is unset", () => {
    const password = process.env.APP_PASSWORD;
    delete process.env.APP_PASSWORD;
    try {
      expect(login("correct-horse")).toBe(false);
    } finally {
      process.env.APP_PASSWORD = password;
    }
  });
});

async function postLogin(password: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

describe("POST /api/auth/login", () => {
  test("sets a hardened session cookie on success", async () => {
    const res = await postLogin("correct-horse");
    expect(res.status).toBe(200);

    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toStartWith("ht_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(verifySession(decodeURIComponent(cookie.split(";")[0].split("=")[1]))).toBe(true);
  });

  test("marks the cookie Secure behind TLS termination", async () => {
    const res = await postLogin("correct-horse", { "x-forwarded-proto": "https" });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  test("401s on a wrong password with no cookie", async () => {
    const res = await postLogin("nope");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("400s on an invalid body", async () => {
    expect((await postLogin(123)).status).toBe(400);
    const noJson = await app.request("/api/auth/login", { method: "POST" });
    expect(noJson.status).toBe(400);
  });

  test("logout clears the cookie without a session", async () => {
    const res = await app.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

describe("requireAuth gate", () => {
  test("leaves /api/health open", async () => {
    expect((await testApp.request("/api/health")).status).toBe(200);
  });

  test("401s a protected route without a cookie", async () => {
    const res = await testApp.request("/api/branches");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("401s a protected route with a tampered cookie", async () => {
    const res = await testApp.request("/api/branches", {
      headers: { cookie: `ht_session=${Date.now() + 1000}.deadbeef` },
    });
    expect(res.status).toBe(401);
  });

  test("200s a protected route with a valid cookie from the login flow", async () => {
    const cookie = (await postLogin("correct-horse")).headers.get("set-cookie")!.split(";")[0];
    const res = await testApp.request("/api/branches", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protected: true });
  });
});

describe("requireCronToken gate", () => {
  const collect = (headers: Record<string, string> = {}) =>
    testApp.request("/api/cron/collect", { method: "POST", headers });

  test("accepts the matching token", async () => {
    expect((await collect({ "x-cron-token": "cron-token-abc" })).status).toBe(200);
  });

  test("401s on a missing or wrong token", async () => {
    expect((await collect()).status).toBe(401);
    expect((await collect({ "x-cron-token": "wrong" })).status).toBe(401);
    expect((await collect({ "x-cron-token": "cron-token-abcd" })).status).toBe(401);
  });

  test("a valid session cookie does not open the cron route", async () => {
    const cookie = (await postLogin("correct-horse")).headers.get("set-cookie")!.split(";")[0];
    expect((await collect({ cookie })).status).toBe(401);
  });

  test("fails closed when CRON_TOKEN is unset", async () => {
    const token = process.env.CRON_TOKEN;
    delete process.env.CRON_TOKEN;
    try {
      expect((await collect({ "x-cron-token": "cron-token-abc" })).status).toBe(401);
    } finally {
      process.env.CRON_TOKEN = token;
    }
  });
});
