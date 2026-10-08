import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const COOKIE_NAME = "ht_session";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Paths (relative to the /api base path) reachable without a session cookie.
 * /cron/* is not listed: it is guarded by requireCronToken instead.
 */
const PUBLIC_PATHS = new Set(["/health", "/auth/login", "/auth/logout"]);

/**
 * Constant-time string comparison. Both sides are hashed first so the
 * comparison operates on fixed-width buffers, which keeps timingSafeEqual from
 * throwing on length mismatch and stops length from leaking through timing.
 */
function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

function requireEnv(name: string): string | null {
  const value = process.env[name];
  if (!value) {
    console.error(`[auth] ${name} is not set — failing closed`);
    return null;
  }
  return value;
}

function sign(exp: number, secret: string): string {
  return createHmac("sha256", secret).update(String(exp)).digest("base64url");
}

/**
 * Session token: `<expiryMillis>.<hmacBase64url>`.
 * Returns null when SESSION_SECRET is unset so callers fail closed.
 */
export function signSession(exp: number = Date.now() + MAX_AGE_SECONDS * 1000): string | null {
  const secret = requireEnv("SESSION_SECRET");
  if (!secret) return null;
  return `${exp}.${sign(exp, secret)}`;
}

export function verifySession(token: string | undefined | null): boolean {
  const secret = requireEnv("SESSION_SECRET");
  if (!secret || !token) return false;

  const dot = token.indexOf(".");
  if (dot <= 0) return false;

  const exp = Number(token.slice(0, dot));
  if (!Number.isSafeInteger(exp) || exp <= Date.now()) return false;

  return safeEqual(token.slice(dot + 1), sign(exp, secret));
}

/** Single-password login. Fails closed when APP_PASSWORD is unset. */
export function login(password: string): boolean {
  const expected = requireEnv("APP_PASSWORD");
  if (!expected) return false;
  return safeEqual(password, expected);
}

/**
 * Secure is set whenever the request arrived over TLS, which is always true on
 * Vercel and false for plain-http local dev — so the flag needs no env wiring.
 */
function isSecureRequest(c: Context): boolean {
  return (
    c.req.header("x-forwarded-proto") === "https" ||
    new URL(c.req.url).protocol === "https:"
  );
}

/** Returns false when no session could be minted (SESSION_SECRET unset). */
export function setSessionCookie(c: Context): boolean {
  const token = signSession();
  if (!token) return false;
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return true;
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/", secure: isSecureRequest(c) });
}

/**
 * Two callers: the GitHub workflow sends `x-cron-token: $CRON_TOKEN`; Vercel
 * Cron sends `Authorization: Bearer $CRON_SECRET` (Vercel's fixed var name).
 */
export const requireCronToken: MiddlewareHandler = async (c, next) => {
  const token = c.req.header("x-cron-token");
  const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  const matches = (provided: string | undefined, envName: string) => {
    if (!provided) return false;
    const expected = requireEnv(envName);
    return !!expected && safeEqual(provided, expected);
  };
  if (!matches(token, "CRON_TOKEN") && !matches(bearer, "CRON_SECRET")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

/** `/lab`, `/lab/...`, `/mcp`, `/mcp/...` — not `/labx` or `/mcpfoo`. All methods: the lab's own tools are called over POST. */
const LAB_PATH = /^\/(lab|mcp)(\/|$)/;

/**
 * `/metrics`, `/sectors`, `/marketstate` and their subpaths — not
 * `/metricsx`. These routes never write, so the bearer only opens them on
 * GET; a hypothetical future write under one of these paths still needs the
 * session cookie.
 */
const READ_PATH = /^\/(metrics|sectors|marketstate)(\/|$)/;

/**
 * Bearer token for the lab surfaces and the read-only paths above (LAB.md
 * "Auth"): any of the comma-separated LAB_API_TOKEN values. Every configured
 * token is compared, so timing does not reveal which one matched. Unset or
 * empty disables bearer.
 */
function labBearerValid(c: Context): boolean {
  const provided = c.req.header("authorization")?.match(/^Bearer +(\S+) *$/i)?.[1];
  if (!provided) return false;
  const tokens = (process.env.LAB_API_TOKEN ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  let ok = false;
  for (const t of tokens) ok = safeEqual(provided, t) || ok;
  return ok;
}

/**
 * Single auth gate for the whole API. Mounted once, before any route, so route
 * modules added later are protected by default without touching this file.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const path = new URL(c.req.url).pathname.replace(/^\/api/, "") || "/";

  if (PUBLIC_PATHS.has(path)) return next();
  if (path.startsWith("/cron/") || path === "/desk/tick") return requireCronToken(c, next);
  // Telegram's webhook carries its own secret header, checked by the route.
  if (path === "/desk/telegram") return next();

  // Lab REST and MCP: session cookie or a LAB_API_TOKEN bearer, any method.
  if (LAB_PATH.test(path)) {
    if (labBearerValid(c) || verifySession(getCookie(c, COOKIE_NAME))) return next();
    if (path.startsWith("/mcp")) c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "unauthorized" }, 401);
  }

  // Metrics/sectors/marketstate: session cookie on any method, or the same
  // bearer but GET only. The bearer grants nothing on any other path.
  if (READ_PATH.test(path)) {
    if ((c.req.method === "GET" && labBearerValid(c)) || verifySession(getCookie(c, COOKIE_NAME))) return next();
    return c.json({ error: "unauthorized" }, 401);
  }

  if (!verifySession(getCookie(c, COOKIE_NAME))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
