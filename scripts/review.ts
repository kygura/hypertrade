// bun run review:postmortem   one JSON line per closed setup in data/setups/ledger.json with no post-mortem yet (ROUTINE.md §2c)
// bun run review:journal      round trips of DESK_WATCH_ADDRESS over the last 30 days, `recent` = closed in the last 7 (ROUTINE.md §4)
// Reads public Hyperliquid info only, under the shared weight guard; writes nothing.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchCandles, hlInfo } from "../src/shared/hl-client.js";
import { LedgerSchema } from "../src/server/routine/schema.js";
import { journalTrips, postmortemFacts, unreviewed } from "../src/server/routine/review.js";

const POSTMORTEMS = "data/review/postmortems";
const cmd = process.argv[2];
const now = new Date();

if (cmd === "postmortem") {
  const ledger = LedgerSchema.parse(JSON.parse(await readFile("data/setups/ledger.json", "utf8")));
  const files = existsSync(POSTMORTEMS) ? await readdir(POSTMORTEMS) : [];
  const reviewed = (await Promise.all(files.map((f) => readFile(join(POSTMORTEMS, f), "utf8")))).join("\n");
  for (const s of unreviewed(ledger.closed, reviewed)) {
    const from = Date.parse(s.triggered_at ?? s.created_at);
    const candles = s.triggered_at ? await fetchCandles(s.asset, "1h", from, Date.parse(s.updated_at)) : [];
    console.log(JSON.stringify(postmortemFacts(s, candles, now)));
  }
} else if (cmd === "journal") {
  const user = process.env.DESK_WATCH_ADDRESS;
  if (!user) {
    console.error("review:journal needs DESK_WATCH_ADDRESS");
    process.exit(2);
  }
  const raw = await hlInfo<unknown>({ type: "userFillsByTime", user, startTime: now.getTime() - 30 * 86_400_000, aggregateByTime: true });
  console.log(JSON.stringify(journalTrips(raw, now), null, 1));
} else {
  console.error("usage: review.ts postmortem | journal");
  process.exit(2);
}
