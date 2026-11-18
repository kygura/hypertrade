import { describe, expect, test } from "bun:test";
import type { Db } from "../platform/store-pg.js";
import { applySchedule } from "../../../db/cron/apply.js";

/** A Db that records what ran; `existing` are the Vault secret names already stored. */
function fake(existing: string[] = []) {
  const calls: Array<[string, unknown[]?]> = [];
  const db: Db = {
    query: async (text, params) => (calls.push([text, params]), (text.startsWith("select id from vault.secrets") && existing.includes(String(params![0])) ? [{ id: "00000000-0000-4000-8000-000000000001" }] : []) as never),
    exec: async (text) => void calls.push([text]),
    tx: async (fn) => fn(db),
  };
  return { db, calls };
}
const ENV = { APP_URL: "https://app.example/", CRON_TOKEN: "tok-secret" };

describe("applySchedule", () => {
  test("does nothing and names what is missing without APP_URL or CRON_TOKEN", async () => {
    const { db, calls } = fake();
    expect(await applySchedule(db, { CRON_TOKEN: "t" }, "select 1")).toBe("APP_URL not set");
    expect(await applySchedule(db, {}, "select 1")).toBe("APP_URL and CRON_TOKEN not set");
    expect(calls).toEqual([]);
  });

  test("creates the secrets (origin without a trailing slash), then runs the schedule; values go as parameters only", async () => {
    const { db, calls } = fake();
    expect(await applySchedule(db, ENV, "begin;\nselect 'schedule';\ncommit;\nselect 2;")).toBeNull();
    expect(calls.map(([t]) => t)).toEqual([
      "create extension if not exists supabase_vault",
      "select id from vault.secrets where name = $1", "select vault.create_secret($1, $2)",
      "select id from vault.secrets where name = $1", "select vault.create_secret($1, $2)",
      "\nselect 'schedule';\n\nselect 2;", // the file's own begin/commit lines are dropped: it runs in the driver's transaction
    ]);
    expect(calls[2]![1]).toEqual(["https://app.example", "hypertrade_app_url"]);
    expect(calls[4]![1]).toEqual(["tok-secret", "hypertrade_cron_token"]);
    expect(calls.some(([t]) => t.includes("tok-secret"))).toBe(false);
  });

  test("an existing secret is updated in place (a rotated token)", async () => {
    const { db, calls } = fake(["hypertrade_cron_token"]);
    await applySchedule(db, ENV, "select 1");
    expect(calls.find(([t]) => t.startsWith("select vault.update_secret"))![1]).toEqual(["00000000-0000-4000-8000-000000000001", "tok-secret"]);
  });
});
