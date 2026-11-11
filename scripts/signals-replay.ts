// Replays the shipped intraday setup predicates once and prints the per-setup table (docs/RESEARCH.md, Intraday replay).
//   bun run signals:replay [--top N] [--source candles|snapshots]
// candles (default): HL 15-min candles + funding for the top N coins by 24 h volume (PLATFORM_REPLAY_TOP, 20); needs
// no database (stored funding is used when DATABASE_URL is set). snapshots: stored scan_snapshots (needs DATABASE_URL).
// No request timeout: the candle fetch runs under the HL weight guard, about 4 coins a minute.
import { databaseUrl, releaseConnection } from "../src/server/db";
import { defaultCandleDeps, formatReplay, replayParams, runCandleReplay, runSnapshotReplay } from "../src/server/platform/replaySource";
import { scanRetentionDays } from "../src/server/platform/store";
import { PgPlatformStore } from "../src/server/platform/store-pg";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const source = arg("--source") ?? "candles";
  const top = arg("--top");
  if (top !== undefined && !/^[1-9]\d*$/.test(top)) throw new Error("--top needs a positive integer");
  if (source === "candles") {
    const t0 = Date.now();
    const r = await runCandleReplay(defaultCandleDeps({ top: top ? Number(top) : undefined, log: (m) => console.error(`[replay] ${m}`) }));
    console.log(formatReplay(r));
    console.error(`[replay] done in ${Math.round((Date.now() - t0) / 1000)} s`);
  } else if (source === "snapshots") {
    if (!databaseUrl()) throw new Error("--source snapshots needs DATABASE_URL");
    console.log(formatReplay(await runSnapshotReplay({ store: new PgPlatformStore(), now: Date.now, sinceDays: scanRetentionDays(), params: replayParams() })));
  } else throw new Error(`unknown --source ${source} (candles | snapshots)`);
}

try {
  await main();
} finally {
  await releaseConnection();
}
