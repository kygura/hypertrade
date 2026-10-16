// Always-on entry (SPEC.md § Platform P0.1): one Bun process serving /api/*
// (the Hono app), dist/ with SPA fallback, and the worker loops. Run with
//   bun run start
// Env: PORT (8787), DATABASE_URL, MIGRATE_ON_BOOT=1, WORKER_LOOPS (all|off|list),
// PLATFORM_RETENTION_DAYS (14).
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { app } from "../api/index";
import { migrate } from "../db/migrate";
import { createNotifier } from "../src/server/desk/notify";
import { createAddressBuffer } from "../src/server/platform/addresses";
import { createAlerts } from "../src/server/platform/alerts";
import { bus } from "../src/server/platform/bus";
import { setPlatformContext } from "../src/server/platform/context";
import { createCrawler } from "../src/server/platform/crawler";
import { createLiqmapLoop } from "../src/server/platform/liqmapLoop";
import { createOutcomesLoop } from "../src/server/platform/outcomesLoop";
import { sql } from "../src/server/db";
import { createScanner } from "../src/server/platform/scanner";
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

  // Cold start: intel_snapshots (15-min rows from /cron/collect) fills the ring until scan_snapshots has 24 h of its own.
  const seedFrom = databaseUrl
    ? async (since: string) =>
        (await sql()`select asset, ts, price, vol24h, funding, oi_usd from intel_snapshots where ts >= ${since} order by ts`).map((r: any) => ({
          coin: String(r.asset), ts: new Date(r.ts).toISOString(), inputs: { mark: r.price, oiUsd: r.oi_usd, funding: r.funding, dayNtlVlm: r.vol24h },
        }))
    : undefined;
  const scanner = createScanner({ store, seedFrom });
  const crawler = createCrawler({ store });
  const liqmap = createLiqmapLoop({ store });
  // A ws mid older than 30 s is not a price; the outcomes loop then falls back to the last scan's mark.
  const outcomes = createOutcomesLoop({ store, mid: (c) => ((ws.midAge(c) ?? Infinity) <= 30_000 ? ws.mid(c) : null), scanMark: scanner.latestMark,
    fillPx: databaseUrl
      ? async (id) => {
          if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
          const [r] = await sql()`select px from desk_paper_fills where proposal_id = ${id} order by ts asc limit 1`;
          return r ? Number(r.px) : null;
        }
      : undefined,
  });
  const alerts = createAlerts({ notifier: createNotifier(), wsAgeSec: () => ws.lastMessageAgeSec(), appUrl: (process.env.APP_URL ?? process.env.DESK_APP_URL)?.trim() });

  const defs: LoopDef[] = [
    // ws.tick opens/maintains the socket and refreshes the universe hourly; throws if the feed goes silent.
    { name: "ws", intervalSec: 30, run: () => ws.tick() },
    { name: "prune", intervalSec: 3600, run: async () => void (await store.pruneHistory(new Date(Date.now() - retentionDays * 86_400_000).toISOString())) },
    scanner.def,
    crawler.def,
    liqmap.def,
    outcomes.def,
    alerts.def,
  ];
  const selected = parseWorkerLoops(process.env.WORKER_LOOPS);
  const wants = (n: string) => selected === "all" || selected.has(n);
  const unsubAlerts = wants("alerts") ? alerts.subscribe(bus) : () => {};
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
    scanHistoryMin: scanner.historyMin(),
    scanAgeSec: scanner.lastScanAt() ? (Date.now() - scanner.lastScanAt()!.getTime()) / 1000 : null,
    crawler: { pollsPerMin: crawler.pollsPerMin(), addresses: await store.addressCount() },
    llmSpendUsdToday: null,
  }));
  setPlatformContext({
    store,
    midAge: (coin, now) => { const ms = ws.midAge(coin, now); return ms == null ? null : ms / 1000; },
    mid: (coin) => ws.mid(coin),
    lastScanAt: scanner.lastScanAt,
    scanIntervalSec: scanner.intervalSec,
  });
  bus.subscribe("ws", ({ state }) => console.log(new Date().toISOString(), "[ws]", state));

  return async () => {
    unsubAlerts();
    setPlatformContext(null);
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
