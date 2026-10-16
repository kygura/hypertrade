import { Hono } from "hono";
import { handle } from "hono/vercel";
import { requireAuth } from "../src/server/auth.js";
import { mcpRoutes } from "../src/server/mcp/http.js";
import { labRegistry } from "../src/server/mcp/lab.js";
import { getHealthExtras } from "../src/server/platform/runtime.js";
import { analystRoutes } from "../src/server/routes/analyst.js";
import { authRoutes } from "../src/server/routes/auth.js";
import { branchesRoutes } from "../src/server/routes/branches.js";
import { candlesRoutes } from "../src/server/routes/candles.js";
import { cronRoutes } from "../src/server/routes/cron.js";
import { createDeskRoutes } from "../src/server/routes/desk.js";
import { engineRoutes } from "../src/server/routes/engine.js";
import { hlRoutes } from "../src/server/routes/hl.js";
import { createIntelRoutes, defaultIntelDeps, telegramIntel } from "../src/server/routes/intel/index.js";
import { labRoutes } from "../src/server/routes/lab.js";
import { marketstateRoutes } from "../src/server/routes/marketstate.js";
import { metricsRoutes } from "../src/server/routes/metrics.js";
import { perpRoutes } from "../src/server/routes/perp.js";
import { routinesRoutes } from "../src/server/routes/routines.js";
import { sectorsRoutes } from "../src/server/routes/sectors.js";

// Vercel still exits the process on an unhandled rejection; this only adds
// the failing SQL (postgres errors carry it on `query`) to the log.
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err, (err as { query?: string })?.query ?? "");
});

// Vercel function limit (s). One function serves every route: the cron
// backfill is budgeted against 300 s (routes/cron.ts); the lab search keeps
// its own 50 s deadline inside this.
export const maxDuration = 300;

const app = new Hono({ strict: false }).basePath("/api");

// Auth gate first: everything mounted below is protected by default.
// Public/cron exceptions live in PUBLIC_PATHS in src/server/auth.ts.
app.use("*", requireAuth);

// Public, and it answers even when loops are down: platform fields are added
// by scripts/server.ts (absent on Vercel), a failing provider never fails the probe.
app.get("/health", async (c) => {
  const base = { ok: true, ts: new Date().toISOString() };
  try {
    return c.json({ ...base, ...(await getHealthExtras()?.()) });
  } catch (err) {
    console.error("[health] extras failed:", err);
    return c.json(base);
  }
});

app.route("/auth", authRoutes);
app.route("/analyst", analystRoutes);

// Mount routes from src/server/routes/ here — no auth wiring needed.
app.route("/branches", branchesRoutes);
app.route("/candles", candlesRoutes);
app.route("/cron", cronRoutes);
// Intel is injected here: routes/desk.ts importing intel/index.ts would cycle (intel/index → desk).
app.route("/desk", createDeskRoutes({ intel: () => telegramIntel() }));
app.route("/engine", engineRoutes);
app.route("/hl", hlRoutes);
app.route("/intel", createIntelRoutes(defaultIntelDeps()));
app.route("/lab", labRoutes());
app.route("/mcp", mcpRoutes(labRegistry));
app.route("/marketstate", marketstateRoutes);
app.route("/metrics", metricsRoutes);
app.route("/perp", perpRoutes);
app.route("/routines", routinesRoutes);
app.route("/sectors", sectorsRoutes);

// Vercel's Node runtime calls a default export as `(req, res)` and ignores a
// returned Response, so a default-exported fetch handler never answers. Named
// HTTP-method exports get the Web signature: Request in, Response out.
const handler = handle(app);
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
export { app };
