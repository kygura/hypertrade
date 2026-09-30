import { Hono } from "hono";
import { handle } from "hono/vercel";
import { requireAuth } from "../src/server/auth.js";
import { analystRoutes } from "../src/server/routes/analyst.js";
import { authRoutes } from "../src/server/routes/auth.js";
import { branchesRoutes } from "../src/server/routes/branches.js";
import { candlesRoutes } from "../src/server/routes/candles.js";
import { cronRoutes } from "../src/server/routes/cron.js";
import { engineRoutes } from "../src/server/routes/engine.js";
import { hlRoutes } from "../src/server/routes/hl.js";
import { marketstateRoutes } from "../src/server/routes/marketstate.js";
import { metricsRoutes } from "../src/server/routes/metrics.js";
import { routinesRoutes } from "../src/server/routes/routines.js";
import { sectorsRoutes } from "../src/server/routes/sectors.js";

const app = new Hono({ strict: false }).basePath("/api");

// Auth gate first: everything mounted below is protected by default.
// Public/cron exceptions live in PUBLIC_PATHS in src/server/auth.ts.
app.use("*", requireAuth);

app.get("/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

app.route("/auth", authRoutes);
app.route("/analyst", analystRoutes);

// Mount routes from src/server/routes/ here — no auth wiring needed.
app.route("/branches", branchesRoutes);
app.route("/candles", candlesRoutes);
app.route("/cron", cronRoutes);
app.route("/engine", engineRoutes);
app.route("/hl", hlRoutes);
app.route("/marketstate", marketstateRoutes);
app.route("/metrics", metricsRoutes);
app.route("/routines", routinesRoutes);
app.route("/sectors", sectorsRoutes);

export default handle(app);
export { app };
