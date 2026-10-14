import { app } from "../api/index";

const port = 8787;

Bun.serve({
  port,
  fetch: app.fetch,
  // Bun closes a silent connection after 10 s by default; the cron routes run up to ~200 s.
  idleTimeout: 255,
});

console.log(`API server running on http://localhost:${port}`);
