import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { migrate } from "../../../db/migrate.js";
import { LedgerSchema, type Setup } from "../../shared/setups.js";
import { newPglite, pgliteDb } from "../testing/pglite.js";
import { exportLedger, MemorySetupStore, PgSetupStore, type SetupStore } from "./store.js";

// Store parity: one scenario through MemorySetupStore and PgSetupStore
// (021_setups.sql on PGlite, applied by db/migrate.ts). Assertions run against
// both, then their outputs must match call for call.

const NOW = new Date(Date.UTC(2026, 9, 20, 12));
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

function setup(over: Partial<Setup> = {}): Setup {
  return {
    id: "BTC-long-20261020-1", setup_id: "funding_fade", levels_source: "code", asset: "BTC", direction: "long", horizon: "swing", timeframe: "4h",
    thesis: "t", regime_alignment: "with", trigger: "4h close above 83k", entry: { low: 82_000, high: 83_000 }, invalidation: 80_000,
    invalidation_reason: "range low", targets: [88_000, 90_000], rr: 2.18, conviction: "medium", evidence: ["hl.BTC.funding"],
    status: "watching", status_note: null, r_result: null, triggered_at: null, created_at: at(-1), updated_at: at(-1), expires_at: at(6), ...over,
  };
}

async function scenario(s: SetupStore): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  expect(await s.open()).toEqual([]);
  expect(await s.get("nope")).toBeNull();

  // A pre-021 ledger row has no setup_id / levels_source: defaults fill them.
  const legacy = { ...setup({ id: "ETH-short-20261001-1", direction: "short", asset: "ETH", created_at: at(-19), updated_at: at(-12) }) } as Record<string, unknown>;
  delete legacy.setup_id;
  delete legacy.levels_source;
  delete legacy.timeframe;
  await s.save([
    legacy as Setup,
    setup(),
    setup({ id: "SOL-long-20261019-1", asset: "SOL", status: "triggered", triggered_at: at(-1), created_at: at(-2) }),
    // same id twice in one call: the last row wins
    setup({ id: "HYPE-long-20261018-1", asset: "HYPE", status: "watching", created_at: at(-3) }),
    setup({ id: "HYPE-long-20261018-1", asset: "HYPE", status: "target_hit", r_result: 2.18, triggered_at: at(-2), created_at: at(-3), updated_at: at(-1) }),
    // closed outside the 90-day retention
    setup({ id: "BTC-short-20260601-1", direction: "short", status: "expired", created_at: at(-140), updated_at: at(-120) }),
  ]);
  out.legacy = await s.get("ETH-short-20261001-1");
  expect(out.legacy).toMatchObject({ setup_id: null, levels_source: "model", timeframe: null, status: "watching" });

  out.open = await s.open();
  expect((out.open as Setup[]).map((x) => x.id)).toEqual(["ETH-short-20261001-1", "SOL-long-20261019-1", "BTC-long-20261020-1"]);

  // replace by id: the ETH setup closes
  await s.save([setup({ id: "ETH-short-20261001-1", direction: "short", asset: "ETH", status: "invalidated", r_result: -1, triggered_at: at(-5), created_at: at(-19), updated_at: at(-4) })]);
  expect((await s.open()).map((x) => x.id)).toEqual(["SOL-long-20261019-1", "BTC-long-20261020-1"]);
  out.closed = await s.closedSince(at(-90));
  expect((out.closed as Setup[]).map((x) => x.id)).toEqual(["HYPE-long-20261018-1", "ETH-short-20261001-1"]);
  expect((await s.closedSince(at(-130))).map((x) => x.id)).toEqual(["HYPE-long-20261018-1", "ETH-short-20261001-1", "BTC-short-20260601-1"]);

  out.ledger = await exportLedger(s, NOW);
  expect(LedgerSchema.parse(out.ledger)).toEqual(out.ledger as never);
  expect((out.ledger as { stats: unknown }).stats).toEqual({ closed_90d: 2, triggered_90d: 2, hit_rate: 0.5, avg_r: 0.59 });

  await s.save([]);
  return out;
}

describe("setups store parity", () => {
  let pg: PgSetupStore;
  let db: ReturnType<typeof pgliteDb>;
  beforeAll(async () => {
    db = pgliteDb(newPglite());
    await migrate(db, () => {});
    pg = new PgSetupStore(db);
  }, 30_000); // every migration on a cold PGlite takes several seconds on a slow runner

  test("memory and pg twins agree call for call", async () => {
    const mem = await scenario(new MemorySetupStore());
    const sql = await scenario(pg);
    expect(sql).toEqual(mem);
  });

  test("pg stores the body as a jsonb object, not a double-encoded string", async () => {
    const rows = await db.query<{ t: string }>(`select distinct jsonb_typeof(body) as t from setups`);
    expect(rows).toEqual([{ t: "object" }]);
  });

  test("the committed ledger file still parses", () => {
    const file = JSON.parse(readFileSync(new URL("../../../data/setups/ledger.json", import.meta.url), "utf8"));
    expect(() => LedgerSchema.parse(file)).not.toThrow();
  });
});
