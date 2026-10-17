// Always-on entry (SPEC.md § Platform P0.1): one Bun process serving /api/*
// (the Hono app), dist/ with SPA fallback, and the worker loops. Run with
//   bun run start
// The port is bound first and boot() (migrate, store, loops) runs behind it: a
// boot failure leaves the UI and /api/health up, with a failed `boot` loop entry.
// Env read by this process:
//   PORT                              listen port (8787)
//   DATABASE_URL                      Postgres; unset = in-memory store, no desk loops
//   MIGRATE_ON_BOOT                   1 = apply db/migrations before starting (needs DATABASE_URL)
//   WORKER_LOOPS                      all (default) | off | comma list of loop names
//   DB_POOL_MAX                       postgres.js pool size (1; use ~5 here)
//   APP_URL / DESK_APP_URL            link in Telegram alerts
//   INTEL_LLM_DAILY_USD               not read here; health LLM spend comes from the same intel accounting
//   PLATFORM_RETENTION_DAYS (14)      prune horizon for scan history
//   PLATFORM_SCAN_INTERVAL_SEC        scanner cadence
//   PLATFORM_CRAWL_WEIGHT_PER_MIN (500), PLATFORM_CRAWL_MAX_AGE_MIN   crawler budget / freshness
//   PLATFORM_LIQMAP_COINS             liquidation-map coins
//   PLATFORM_OUTCOME_HORIZONS         outcome marking horizons
//   PLATFORM_READY_TTL_MIN, PLATFORM_COOLDOWN_MIN, PLATFORM_EDGE_MIN_N   opportunity lifecycle
//   PLATFORM_RESEARCH_SCORE, PLATFORM_PUSH_SCORE   score thresholds (research feed / Telegram push)
//   PLATFORM_COST_TOP_N               cost model top-N coins
// Desk loops also read DESK_WORKER_TICK_SEC and DESK_TELEGRAM_* (scripts/desk-worker.ts).
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
import { createOutcomesLoop, skipped as outcomesSkipped } from "../src/server/platform/outcomesLoop";
import { sql, setLongRunning } from "../src/server/db";
import { defaultDeskService } from "../src/server/routes/desk";
import { PgIntelStore } from "../src/server/intel/store";
import { usageCost } from "../src/server/intel/llm";
import { createReconcileLoop } from "../src/server/platform/reconcile";
import { createScanner } from "../src/server/platform/scanner";
import { setHealthExtras, parseWorkerLoops, startLoops, type LoopDef, type Loops } from "../src/server/platform/runtime";
import { MemoryPlatformStore } from "../src/server/platform/store-memory";
import { PgPlatformStore, pgDb } from "../src/server/platform/store-pg";
import type { PlatformStore } from "../src/server/platform/store";
import { createWsIngest, MID_MAX_AGE_MS } from "../src/server/platform/ws";
import type { PlatformHealth } from "../src/shared/platform";

const DIST = resolve(import.meta.dir, "../dist");

/** /api/* -> the Hono app (mounted at basePath /api, so the path is passed through untouched); else dist/ with SPA fallback. */
export function createHandler(api: (req: Request) => Response | Promise<Response>, dist = DIST) {
  const index = join(dist, "index.html");
  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return api(req);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405 });
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    let file = resolve(dist, "." + normalize(decoded));
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

/** Last good value of a slow health probe, refreshed at most every ttlMs, each try capped at 2 s; `fallback` until one succeeds. */
function cached<T>(ttlMs: number, fn: () => Promise<T>, fallback: T): () => Promise<T> {
  let at = -Infinity;
  let v = fallback;
  return async () => {
    if (Date.now() - at < ttlMs) return v;
    at = Date.now();
    try {
      v = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("probe timeout")), 2_000).unref())]);
    } catch {}
    return v;
  };
}

async function boot() {
  setLongRunning(true);
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
  // A ws mid older than MID_MAX_AGE_MS is not a price; the outcomes loop then falls back to the last scan's mark.
  const outcomes = createOutcomesLoop({ store, mid: (c) => ((ws.midAgeMs(c) ?? Infinity) <= MID_MAX_AGE_MS ? ws.mid(c) : null), scanMark: scanner.latestMark,
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
  // Desk loops need the Postgres-backed desk store; in memory mode they would only fail.
  if (databaseUrl) defs.push(createReconcileLoop({ store, desk: defaultDeskService, now: () => new Date() }));
  if (databaseUrl && (wants("desk") || wants("telegram"))) {
    // Dynamic: importing desk-worker builds the desk service, which only the worker needs.
    const desk = await import("./desk-worker");
    if (wants("desk")) defs.push({ name: "desk", intervalSec: desk.deskTickSec, run: desk.deskTickOnce });
    const poll = wants("telegram") ? await desk.createTelegramPoll() : null;
    // A getUpdates long-poll takes up to 25 s, so the beat is judged against 60 s.
    if (poll) defs.push({ name: "telegram", intervalSec: 0, expectedIntervalSec: 60, run: poll });
  }

  const loops: Loops = startLoops(defs, { only: selected });
  const shutdown = async () => {
    unsubAlerts();
    setPlatformContext(null);
    ws.stop();
    await Promise.all([loops.stop(), addresses.stop()]);
  };
  // Loops are already running: if the rest of boot throws, stop them rather than orphan them behind a "boot failed" health.
  return orStop(() => {
    const addressCount = cached(30_000, () => store.addressCount(), 0);
    const intel = databaseUrl ? new PgIntelStore() : null;
    const llmSpend = cached<number | null>(60_000, async () => {
      const n = new Date();
      const dayStart = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
      return (await intel!.usageSince(dayStart)).reduce<number>((sum, u) => sum + usageCost(u), 0);
    }, null);
    setHealthExtras(async () => ({
      store: storeKind,
      loops: loops.health(),
      ws: { state: selected === "all" || selected.has("ws") ? ws.state : "off", lastMessageAgeSec: ws.lastMessageAgeSec() },
      scanHistoryMin: scanner.historyMin(),
      scanAgeSec: scanner.lastScanAt() ? (Date.now() - scanner.lastScanAt()!.getTime()) / 1000 : null,
      crawler: { pollsPerMin: crawler.pollsPerMin(), addresses: await addressCount() },
      llmSpendUsdToday: intel ? await llmSpend() : null,
      outcomesSkipped: outcomesSkipped(),
    }));
    setPlatformContext({
      store,
      midAge: (coin, now) => { const ms = ws.midAgeMs(coin, now); return ms == null ? null : ms / 1000; },
      mid: (coin) => ws.mid(coin),
      lastScanAt: scanner.lastScanAt,
      scanIntervalSec: scanner.intervalSec,
    });
    bus.subscribe("ws", ({ state }) => console.log(new Date().toISOString(), "[ws]", state));
    return shutdown;
  }, shutdown);
}

/** Runs `fn`; if it throws, runs `cleanup` (errors swallowed) and rethrows. */
export function orStop<T>(fn: () => T, cleanup: () => Promise<void>): Promise<T> {
  return Promise.resolve().then(fn).catch(async (err) => {
    await cleanup().catch(() => {});
    throw err;
  });
}

/** Binds the port first, then boots in the background; a boot failure shows up in /api/health as a failed `boot` loop. */
export function start({ port, boot: bootFn = boot, api = app.fetch, dist = DIST }: { port: number; boot?: () => Promise<() => Promise<void>>; api?: (req: Request) => Response | Promise<Response>; dist?: string }) {
  const server = Bun.serve({
    port,
    fetch: createHandler(api, dist),
    // Bun closes a silent connection after 10 s by default; the cron routes run up to ~200 s.
    idleTimeout: 255,
  });
  let stopBoot = async () => {};
  const booted = bootFn().then(
    (stop) => void (stopBoot = stop),
    (err) => {
      const error = err instanceof Error ? err.message : String(err);
      console.error("boot failed; serving degraded:", err);
      // Full non-redacted shape, so the cockpit shows the failed `boot` loop instead of gray items.
      setHealthExtras(() => ({
        store: process.env.DATABASE_URL?.trim() ? "pg" : "memory",
        loops: [{ name: "boot", lastBeatAt: null, expectedIntervalSec: 1, ok: false, error }],
        ws: { state: "off", lastMessageAgeSec: null },
        scanAgeSec: null,
        crawler: { pollsPerMin: 0, addresses: 0 },
        llmSpendUsdToday: null,
      }));
    },
  );
  return { server, booted, stop: async () => (await booted, await stopBoot().catch((err) => console.error("shutdown:", err)), await server.stop()) };
}

if (import.meta.main) {
  const { server, stop } = start({ port: Number(process.env.PORT) || 8787 });
  console.log(`server listening on :${server.port}`);
  let closing = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      if (closing) return;
      closing = true;
      console.log(`${sig}: shutting down`);
      setTimeout(() => process.exit(1), 10_000).unref();
      await stop().catch((err) => console.error("shutdown:", err));
      process.exit(0);
    });
  }
}
