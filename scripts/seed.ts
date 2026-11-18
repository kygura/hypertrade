// bun run seed:snapshots [--dry-run] [--top N] [COIN ...]
// Fills the gaps of scan_snapshots on the 15-min grid from Hyperliquid candles, funding and Coinalyze open interest
// (src/server/platform/seed.ts), about 15 to 20 days back: what the scanner ring, the extremes job and the snapshot
// replay read. Needs DATABASE_URL and COINALYZE_API_KEY. Idempotent: a slot that holds a row is never rewritten.
// No coins given: the top N by 24 h volume (PLATFORM_REPLAY_TOP, 20) plus BTC. Run with --dry-run first: it prints,
// per coin, the rows it would write and the seeded-to-stored OI ratio where both exist (expect about 1).
import { databaseUrl, releaseConnection } from "../src/server/db";
import { DEFAULT_REPLAY_TOP, defaultCandleDeps } from "../src/server/platform/replaySource";
import { envNum } from "../src/server/platform/scanner";
import { coinalyzeIntradayOi, runSnapshotSeed } from "../src/server/platform/seed";
import { PgPlatformStore } from "../src/server/platform/store-pg";
import { selectUniverse } from "../src/server/platform/universe";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const topAt = args.indexOf("--top");
const top = topAt >= 0 ? Number(args[topAt + 1]) : envNum("PLATFORM_REPLAY_TOP", DEFAULT_REPLAY_TOP);
const named = args.filter((a, i) => !a.startsWith("--") && i !== topAt + 1);

try {
  const key = process.env.COINALYZE_API_KEY?.trim();
  if (!databaseUrl()) throw new Error("DATABASE_URL is required");
  if (!key) throw new Error("COINALYZE_API_KEY is required");
  if (!Number.isInteger(top) || top < 1) throw new Error("--top needs a positive integer");
  const hl = defaultCandleDeps();
  const reports = await runSnapshotSeed({
    coins: async () => (named.length ? named : [...new Set([...selectUniverse(await hl.universe(), { top }).map((c) => c.coin), "BTC"])]),
    candles: hl.candles,
    funding: hl.funding,
    oi: coinalyzeIntradayOi(key, { fetch, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
    store: new PgPlatformStore(),
    now: Date.now,
    dryRun: flag("--dry-run"),
    log: (m) => console.log(m),
  });
  const skipped = reports.filter((r) => r.skipped).length;
  console.log(`${flag("--dry-run") ? "dry run: " : ""}${reports.reduce((n, r) => n + (flag("--dry-run") ? r.planned : r.written), 0)} rows over ${reports.length - skipped} coins, ${skipped} skipped`);
  if (reports.length && skipped === reports.length) process.exitCode = 1;
} finally {
  await releaseConnection();
}
