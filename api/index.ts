import { Hono } from "hono";
import { handle } from "hono/vercel";

const app = new Hono({ strict: false }).basePath("/api");

app.get("/health", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

// Mount routes from src/server/routes/ here
// e.g., app.use("/branches", branchesRouter);
// e.g.: app.use("/auth", authRouter);
// e.g.: app.use("/metrics", metricsRouter);

export default handle(app);
export { app };
