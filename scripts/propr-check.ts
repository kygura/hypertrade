// Read-only check of a Propr account before PROPR_LIVE=true (docs/PROPR.md): GET requests only, nothing is placed,
// changed or cancelled. Confirms what Propr's published docs leave open: that X-API-Key auth works, that
// GET /accounts/{id} carries the balance fields the desk reads, the order and fill field names, and paging.
//
//   PROPR_API_KEY=... PROPR_ACCOUNT_ID=... bun run propr:check [COIN]
import { readSnapshot, utcMidnight } from "../src/server/desk/propr/account.js";
import { ProprClient, proprBaseUrl, scrub } from "../src/server/desk/propr/client.js";
import { isLadderId, isPerpRadarId } from "../src/server/desk/propr/ids.js";

const key = process.env.PROPR_API_KEY?.trim();
const accountId = process.env.PROPR_ACCOUNT_ID?.trim();
const coin = (process.argv[2] ?? "BTC").toUpperCase();
if (!key || !accountId) {
  console.error("set PROPR_API_KEY and PROPR_ACCOUNT_ID");
  process.exit(1);
}
const start = Number(process.env.PROPR_STARTING_BALANCE?.trim() || NaN);
const client = new ProprClient(key, proprBaseUrl(process.env.PROPR_API_URL));
const now = Date.now();
const fields = (o: Record<string, unknown> | undefined) => (o ? Object.keys(o).sort().join(", ") : "none");

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.log(`✗ ${name}: ${scrub(e instanceof Error ? e.message : String(e))}`);
    return null;
  }
}

console.log(`Propr read-only check · ${client.base} · account ${accountId}\n`);

const attempts = await step("challenge attempts (auth with X-API-Key)", () => client.attempts());
if (attempts) {
  const mine = attempts.find((a) => a.accountId === accountId);
  console.log(`✓ auth works · ${attempts.length} tradable attempt(s) · this account: ${mine ? `status ${String(mine.status)}` : "NOT FOUND among active or passed attempts"}`);
  if (mine) console.log(`  attempt fields: ${fields(mine)}`);
}

const account = await step("GET /accounts/{id}", () => client.account(accountId));
if (account) {
  console.log(`✓ account · balance ${String(account.balance)} · marginBalance ${String(account.marginBalance)} · totalUnrealizedPnl ${String(account.totalUnrealizedPnl)}`);
  console.log(`  account fields: ${fields(account)}`);
}

const positions = await step("positions", () => client.positions(accountId));
if (positions) console.log(`✓ ${positions.length} open position(s)${positions[0] ? ` · fields: ${fields(positions[0])}` : ""}`);

const orders = await step("orders (all pages)", () => client.orders(accountId));
if (orders) {
  const desk = orders.filter((o) => isLadderId(o.intentId)).length;
  const radar = orders.filter((o) => isPerpRadarId(o.intentId)).length;
  console.log(`✓ ${orders.length} order(s) · desk ladders (PRD): ${desk} · perp-radar (PRX): ${radar}`);
  const filled = orders.find((o) => o.status === "filled");
  if (filled) console.log(`  a filled order's fields: ${fields(filled)}`);
  if (orders.some((o) => o.orderGroupId != null)) console.log("  orderGroupId is echoed on orders");
}

const trades = await step("trades since 00:00 UTC", () => client.trades(accountId, utcMidnight(now)));
if (trades) console.log(`✓ ${trades.length} trade(s) read back to 00:00 UTC${trades[0] ? ` · fields: ${fields(trades[0])}` : ""}`);

const mc = await step(`margin config for ${coin}`, () => client.marginConfig(accountId, coin));
if (mc) console.log(`✓ ${coin} margin · ${mc.marginMode} ${mc.leverage}x`);

const snap = await step("the desk's snapshot", () => readSnapshot(client, accountId, Number.isFinite(start) && start > 0 ? start : undefined, now));
if (snap) {
  console.log(`✓ snapshot · equity ${snap.equity} · day start ${snap.dayStartBalance} · starting ${snap.startingBalance} · entries today ${snap.entriesToday}`);
  for (const p of snap.positions) console.log(`  ${p.coin} ${p.side} ${p.qty} · stop ${p.stop ?? "NONE (unprotected)"}`);
}
console.log("\nNothing was sent: GET requests only.");
