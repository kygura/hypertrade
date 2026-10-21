// Writes the setups ledger from Postgres to JSON for the stateless routine session.
//   bun run setups:export [--out data/setups/ledger.json]
// Env: DATABASE_URL (unset = prints a notice and exits 0). Same shape and formatting as the routine's own write.
import { writeFile } from "node:fs/promises";
import { databaseUrl, releaseConnection } from "../src/server/db";
import { pgDb } from "../src/server/platform/store-pg";
import { exportLedger, PgSetupStore } from "../src/server/setups/store";

async function main() {
  if (!databaseUrl()) return console.log("setups export skipped: DATABASE_URL is not set");
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? process.argv[i + 1] : "data/setups/ledger.json";
  if (!out) throw new Error("--out needs a path");
  const ledger = await exportLedger(new PgSetupStore(pgDb()), new Date());
  await writeFile(out, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`setups export: ${ledger.open.length} open, ${ledger.closed.length} closed -> ${out}`);
}

try {
  await main();
} finally {
  await releaseConnection();
}
