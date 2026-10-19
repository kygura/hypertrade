import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { releaseConnection, sql } from "../db.js";
import { pgStore } from "./store.js";

// pgStore trial log against a real Postgres. Runs only with INTEL_PG_TEST_URL set:
//   INTEL_PG_TEST_URL=postgres://postgres@127.0.0.1:5433/hypertrade bun test src/server/lab/store.pg.test.ts
// Applies 014_lab_trials.sql into a throwaway schema and drops it after.

const PG_URL = process.env.INTEL_PG_TEST_URL;
const SCHEMA = `lab_test_${process.pid}_${Date.now()}`;
const MIGRATION = new URL("../../../db/migrations/014_lab_trials.sql", import.meta.url);

describe.skipIf(!PG_URL)("pgStore trials (real Postgres)", () => {
  const saved = process.env.DATABASE_URL;
  const savedPool = process.env.DB_POOL_MAX;
  const usePath = () => sql().unsafe(`set search_path to "${SCHEMA}"`);

  beforeAll(async () => {
    process.env.DATABASE_URL = PG_URL;
    process.env.DB_POOL_MAX = "1"; // search_path is per connection
    await releaseConnection();
    await sql().unsafe(`create schema "${SCHEMA}"`);
    await usePath();
    await sql().unsafe(readFileSync(MIGRATION, "utf8"));
  });

  beforeEach(async () => {
    await usePath();
  });

  afterAll(async () => {
    try {
      await sql().unsafe(`set client_min_messages to warning`);
      await sql().unsafe(`drop schema if exists "${SCHEMA}" cascade`);
    } finally {
      await releaseConnection();
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
      if (savedPool === undefined) delete process.env.DB_POOL_MAX;
      else process.env.DB_POOL_MAX = savedPool;
    }
  });

  test("appendTrial numbers ideas 1..N and listTrials returns them in order", async () => {
    const s = pgStore();
    expect(await s.listTrials()).toEqual([]);
    const a = await s.appendTrial({ ruleId: "r1", intent: "fade funding", verdict: "robust" });
    const b = await s.appendTrial({ ruleId: "r2", intent: null, verdict: null });
    expect([a.n, b.n]).toEqual([1, 2]);
    expect(a).toMatchObject({ ruleId: "r1", intent: "fade funding", verdict: "robust" });
    expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(b).toMatchObject({ intent: null, verdict: null });
    expect(await s.listTrials()).toEqual([a, b]);
  });
});
