// Always-on entry (SPEC.md § Platform P0.1): one Bun process serving /api/*
// (the Hono app), dist/ with SPA fallback, and the worker loops. Run with
//   bun run start
// Env: PORT (8787), DATABASE_URL, MIGRATE_ON_BOOT=1, WORKER_LOOPS (all|off|list),
// PLATFORM_RETENTION_DAYS (14).
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { app } from "../api/index";
import { migrate } from "../db/migrate";
import { createAddressBuffer } from "../src/server/platform/addresses";
import { bus } from "../src/server/platform/bus";
import { setHealthExtras, parseWorkerLoops, startLoops, type LoopDef, type Loops } from "../src/server/platform/runtime";
import { MemoryPlatformStore } from "../src/server/platform/store-memory";
import { PgPlatformStore, pgDb } from "../src/server/platform/store-pg";
import type { PlatformStore } from "../src/server/platform/store";
import { createWsIngest } from "../src/server/platform/ws";
import type { PlatformHealth } from "../src/shared/platform";

const DIST = resolve(import.meta.dir, "../dist");

/** /api/* -> the Hono app (mounted at basePath /api, so the path is passed through untouched); else dist/ with SPA fallback. */
export function createHandler(api: (req: Request) => Response | Promise<Response>, dist = DIST) {
  const index = join(dist, "index.html");
  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return api(req);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
    let file = resolve(dist, "." + normalize(decodeURIComponent(pathname)));
    const inside = file === dist || file.startsWith(dist + "/");
    const hit = inside && existsSync(file) && statSync(file).isFile();
    // Missing asset files are real 404s; any other path is a client route.
    if (!hit && /\.[a-z0-9]+$/i.test(pathname)) return new Response("Not Found", { status: 404 });
    if (!hit) file = index;
    if (!existsSync(file)) return new Response("Not Found", { status: 404 });
    // Vite hashes everything under /assets/; index.html must always revalidate.
    const cache = pathname.startsWith("/assets/") && file !== index ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(Bun.file(file), { headers: { "cache-control": cache } });
  };
}

async function boot() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (process.env.MIGRATE_ON_BOOT === "1") {
    if (!databaseUrl) throw new Error("MIGRATE_ON_BOOT=1 needs DATABASE_URL");
    await migrate(pgDb());
  }
  const storeKind: PlatformHealth["store"] = databaseUrl ? "pg" : "memory";
  const store: PlatformStore = databaseUrl ? new PgPlatformStore() : new MemoryPlatformStore();

  const addresses = createAddressBuffer(store);
  const ws = createWsIngest({ onAddresses: (a, t) => addresses.add(a, t) });
  const retentionDays = Number(process.env.PLATFORM_RETENTION_DAYS ?? 14) || 14;

  const defs: LoopDef[] = [
    // ws.tick opens/maintains the socket and refreshes the universe hourly; throws if the feed goes silent.
    { name: "ws", intervalSec: 30, run: () => ws.tick() },
    { name: "prune", intervalSec: 3600, run: async () => void (await store.pruneHistory(new Date(Date.now() - retentionDays * 86_400_000).toISOString())) },
    // TODO(T4): scanner (PLATFORM_SCAN_INTERVAL_SEC), crawler, liqmap (15 min), outcomes (60 s) register here.
  ];
  const selected = parseWorkerLoops(process.env.WORKER_LOOPS);
  const wants = (n: string) => selected === "all" || selected.has(n);
  if (wants("desk") || wants("telegram")) {
    // Dynamic: importing desk-worker builds the desk service, which only the worker needs.
    const desk = await import("./desk-worker");
    if (wants("desk")) defs.push({ name: "desk", intervalSec: desk.deskTickSec, run: desk.deskTickOnce });
    const poll = wants("telegram") ? await desk.createTelegramPoll() : null;
    // A getUpdates long-poll takes up to 25 s, so the beat is judged against 60 s.
    if (poll) defs.push({ name: "telegram", intervalSec: 0, expectedIntervalSec: 60, run: poll });
  }

  const loops: Loops = startLoops(defs, { only: selected });
  setHealthExtras(async () => ({
    store: storeKind,
    loops: loops.health(),
    ws: { state: selected === "all" || selected.has("ws") ? ws.state : "off", lastMessageAgeSec: ws.lastMessageAgeSec() },
    scanAgeSec: null, // TODO(T4)
    crawler: { pollsPerMin: 0, addresses: await store.addressCount() }, // TODO(T4): polls/min
    llmSpendUsdToday: null,
  }));
  bus.subscribe("ws", ({ state }) => console.log(new Date().toISOString(), "[ws]", state));

  return async () => {
    await loops.stop();
    ws.stop();
    await addresses.stop();
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT) || 8787;
  const stop = await boot();
  const server = Bun.serve({
    port,
    fetch: createHandler(app.fetch),
    // Bun closes a silent connection after 10 s by default; the cron routes run up to ~200 s.
    idleTimeout: 255,
  });
  console.log(`server listening on :${server.port}`);
  let closing = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      if (closing) return;
      closing = true;
      console.log(`${sig}: shutting down`);
      setTimeout(() => process.exit(1), 10_000).unref();
      await server.stop();
      await stop().catch((err) => console.error("shutdown:", err));
      process.exit(0);
    });
  }
}
