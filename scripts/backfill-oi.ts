// bun scripts/backfill-oi.ts [COIN ...]
// Backfills daily hl.oi.<COIN> history from Coinalyze (see src/server/collectors/coinalyzeOi.ts). Idempotent: days that
// already have an observation are never touched. Needs DATABASE_URL and COINALYZE_API_KEY. No coins given: the
// liquidity-tier-1 coins of the live universe (the novelty loop's default).
import { hlInfo, parseMetaAndCtxs } from "../src/shared/hl-client";
import { defaultOiBackfill } from "../src/server/collectors/coinalyzeOi";
import { databaseUrl } from "../src/server/db";
import { defaultHtDeps } from "../src/server/lab/providers/ht";
import { liquidityTiers } from "../src/server/platform/features";

if (!databaseUrl()) throw new Error("DATABASE_URL is required");
if (!process.env.COINALYZE_API_KEY?.trim()) throw new Error("COINALYZE_API_KEY is required");

let coins = process.argv.slice(2);
if (!coins.length) {
  const u = parseMetaAndCtxs(await hlInfo<unknown>({ type: "metaAndAssetCtxs" })).ctxs.filter((c) => !c.isDelisted).map((c) => ({ coin: c.name, dayNtlVlm: c.dayNtlVlm }));
  const tiers = liquidityTiers(u);
  coins = u.filter((c) => tiers[c.coin] === 1).map((c) => c.coin);
}
const backfill = defaultOiBackfill();
let failed = 0;
for (const coin of coins) {
  try {
    await defaultHtDeps.ensureHistory(coin, Date.now() - 1500 * 86_400_000, 60_000); // closes for the USD conversion
    console.log(`${coin}: ${await backfill(coin)} days inserted`);
  } catch (e) {
    failed++;
    console.error(`${coin}: ${e instanceof Error ? e.message : e}`);
  }
}
process.exit(failed === coins.length ? 1 : 0);
