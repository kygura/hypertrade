// bun scripts/novelty-replay.ts [COIN ...] [--days 365]
// Replays the novelty detector over the last N closed daily bars of the stored data (candles 1d, funding, hl.oi
// observations; DATABASE_URL required, nothing is fetched or backfilled) and prints entries/day and pushes/day.
// No coins given: the liquidity-tier-1 coins of the live universe. A coin with under 365 bars adds nothing.
import { hlInfo, parseMetaAndCtxs } from "../src/shared/hl-client";
import { databaseUrl, getCandles, getFunding, seriesRange } from "../src/server/db";
import { liquidityTiers } from "../src/server/platform/features";
import { replay } from "../src/server/platform/novelty";
import { alignDaily } from "../src/server/platform/noveltyLoop";

const args = process.argv.slice(2);
const di = args.indexOf("--days");
const days = di >= 0 ? Number(args.splice(di, 2)[1]) || 365 : 365;
if (!databaseUrl()) throw new Error("DATABASE_URL is required: the replay reads stored candles, funding and observations");

let coins = args;
if (!coins.length) {
  const u = parseMetaAndCtxs(await hlInfo<unknown>({ type: "metaAndAssetCtxs" })).ctxs.filter((c) => !c.isDelisted).map((c) => ({ coin: c.name, dayNtlVlm: c.dayNtlVlm }));
  const tiers = liquidityTiers(u);
  coins = u.filter((c) => tiers[c.coin] === 1).map((c) => c.coin);
}

const now = Date.now();
const dailies = Object.fromEntries(
  await Promise.all(coins.map(async (coin) => {
    const [bars, funding, oi] = await Promise.all([getCandles(coin, "1d"), getFunding(coin, new Date(0), new Date(now)), seriesRange(`hl.oi.${coin}`)]);
    return [coin, alignDaily({
      bars: bars.map((b) => ({ t: new Date(b.ts).getTime(), c: Number(b.c), v: Number(b.v ?? 0) })),
      funding: funding.map((r) => ({ t: new Date(r.ts).getTime(), rate: Number(r.rate) })),
      oi: oi.map((p) => ({ t: new Date(p.ts).getTime(), v: Number(p.value) })),
    }, now)] as const;
  })),
);
const usable = Object.fromEntries(Object.entries(dailies).filter(([, d]) => d.t.length >= 365));
console.log(`${Object.keys(usable).length} of ${coins.length} coins have 365+ closed bars; OI history (days): ${Object.entries(usable).map(([c, d]) => `${c}=${d.oi.filter((x) => x != null).length}`).join(" ")}`);
if (!Object.keys(usable).length) process.exit(0);

const { entries, perDay } = replay(usable, days);
const n = Object.keys(perDay).length;
const pushes = entries.filter((e) => e.pushed).length;
console.log(`${n} bars, ${entries.length} entries (${(entries.length / n).toFixed(2)}/day), ${pushes} pushes (${(pushes / n).toFixed(2)}/day)`);
for (const [bar, v] of Object.entries(perDay)) if (v.entries) console.log(`${bar}  entries ${v.entries}  pushes ${v.pushes}`);
