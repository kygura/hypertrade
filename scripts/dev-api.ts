import { app } from "../api/index";

const port = 8787;

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`API server running on http://localhost:${port}`);
