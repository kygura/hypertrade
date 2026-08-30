import { app } from "../api/index";
var port = 8787;
Bun.serve({
    port: port,
    fetch: app.fetch,
});
console.log("API server running on http://localhost:".concat(port));
