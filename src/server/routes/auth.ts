import { Hono } from "hono";
import { z } from "zod";
import { clearSessionCookie, login, setSessionCookie } from "../auth";

const loginBody = z.object({ password: z.string().min(1) });

/** Fixed delay on failed login. Cheap brute-force tax with no extra deps. */
const FAILURE_DELAY_MS = 250;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const authRoutes = new Hono()
  .post("/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = loginBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);

    if (!login(parsed.data.password) || !setSessionCookie(c)) {
      await delay(FAILURE_DELAY_MS);
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ ok: true });
  })
  .post("/logout", (c) => {
    clearSessionCookie(c);
    return c.json({ ok: true });
  })
  // Session probe for the frontend route guard; requireAuth already protects it.
  .get("/me", (c) => c.json({ ok: true }));
