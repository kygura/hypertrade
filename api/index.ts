import { Hono } from "hono";
import { handle } from "hono/vercel";
import { requireAuth } from "../src/server/auth";
import { authRoutes } from "../src/server/routes/auth";

const app = new Hono({ strict: false }).basePath("/api");

// Auth gate first: everything mounted below is protected by default.
// Public/cron exceptions live in PUBLIC_PATHS in src/server/auth.ts.
app.use("*", requireAuth);

app.get("/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

app.route("/auth", authRoutes);

// Mount routes from src/server/routes/ here — no auth wiring needed.
// e.g.: app.route("/branches", branchesRoutes);
// e.g.: app.route("/metrics", metricsRoutes);

export default handle(app);
export { app };
