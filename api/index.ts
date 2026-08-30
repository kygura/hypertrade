import { Hono } from "hono";
import { handle } from "hono/vercel";
import { requireAuth } from "../src/server/auth";
import { authRoutes } from "../src/server/routes/auth";
import { branchesRoutes } from "../src/server/routes/branches";
import { candlesRoutes } from "../src/server/routes/candles";
import { cronRoutes } from "../src/server/routes/cron";
import { hlRoutes } from "../src/server/routes/hl";
import { marketstateRoutes } from "../src/server/routes/marketstate";
import { metricsRoutes } from "../src/server/routes/metrics";
import { routinesRoutes } from "../src/server/routes/routines";
import { sectorsRoutes } from "../src/server/routes/sectors";

const app = new Hono({ strict: false }).basePath("/api");

// Auth gate first: everything mounted below is protected by default.
// Public/cron exceptions live in PUBLIC_PATHS in src/server/auth.ts.
app.use("*", requireAuth);

app.get("/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

app.route("/auth", authRoutes);

// Mount routes from src/server/routes/ here — no auth wiring needed.
app.route("/branches", branchesRoutes);
app.route("/candles", candlesRoutes);
app.route("/cron", cronRoutes);
app.route("/hl", hlRoutes);
app.route("/marketstate", marketstateRoutes);
app.route("/metrics", metricsRoutes);
app.route("/routines", routinesRoutes);
app.route("/sectors", sectorsRoutes);

export default handle(app);
export { app };
