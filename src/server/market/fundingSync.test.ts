import { describe, expect, test } from "bun:test";
import type { FundingPoint } from "../../shared/hl-client.js";
import type { SyncState } from "../db.js";
import { syncFunding, type FundingDeps } from "./fundingSync.js";

const H = 3_600_000;
const LISTING = Date.UTC(2024, 0, 1);

/** HL with hourly settlements from LISTING to `now`, 500 per page. */
function harness(now: number) {
  const all: FundingPoint[] = [];
  for (let t = LISTING; t <= now; t += H) all.push({ t, rate: 0.00001, premium: 0.0002 });
  const stored = new Map<number, FundingPoint>();
  let state: SyncState = { coin: "BTC", series: "funding", hlFloor: null, ext: {}, syncedAt: null, accessedAt: null, error: null };
  const calls: [number, number][] = [];
  const deps: FundingDeps = {
    now: () => now,
    async page(_coin, start, end) {
      calls.push([start, end]);
      return all.filter((r) => r.t >= start && r.t <= end).slice(0, 500);
    },
    async bounds() {
      const ts = [...stored.keys()].sort((a, b) => a - b);
      return ts.length ? { min: ts[0]!, max: ts[ts.length - 1]! } : null;
    },
    async upsert(_coin, rows) {
      for (const r of rows) stored.set(r.t, r);
    },
    async getState() {
      return structuredClone(state);
    },
    async saveState(s) {
      state = structuredClone(s);
    },
  };
  return { deps, stored, calls, state: () => state };
}

describe("syncFunding", () => {
  test("pages backward from now until `from` is covered", async () => {
    const now = LISTING + 2000 * H;
    const h = harness(now);
    const r = await syncFunding("BTC", now - 700 * H, { maxPages: 10 }, h.deps);
    expect(r.pages).toBe(2);
    expect(r.from).toBeLessThanOrEqual(now - 700 * H);
    expect(r.complete).toBe(false);
  });

  test("finds the listing and reports complete history", async () => {
    const now = LISTING + 1200 * H;
    const h = harness(now);
    const r = await syncFunding("BTC", 0, { maxPages: 10 }, h.deps);
    expect(h.stored.size).toBe(1201);
    expect(r.from).toBe(LISTING);
    expect(r.complete).toBe(true);
    expect(h.state().hlFloor).toBe(LISTING);

    const again = await syncFunding("BTC", 0, { maxPages: 10 }, h.deps);
    expect(again.pages).toBe(0); // nothing to do: head fresh, floor reached
  });

  test("head sync pages forward from the newest stored row", async () => {
    const now = LISTING + 1200 * H;
    const h = harness(now);
    for (let t = LISTING; t <= LISTING + 100 * H; t += H) h.stored.set(t, { t, rate: 0, premium: 0 });
    await syncFunding("BTC", LISTING, { maxPages: 10 }, h.deps);
    expect(h.calls[0]).toEqual([LISTING + 100 * H + 1, now]);
    expect(h.stored.size).toBe(1201);
  });

  test("respects the page budget", async () => {
    const now = LISTING + 5000 * H;
    const h = harness(now);
    const r = await syncFunding("BTC", 0, { maxPages: 3 }, h.deps);
    expect(r.pages).toBe(3);
    expect(h.stored.size).toBe(1500);
  });

  test("an upstream error is recorded, not thrown", async () => {
    const h = harness(LISTING + 10 * H);
    h.deps.page = async () => {
      throw new Error("HL 429");
    };
    const r = await syncFunding("BTC", 0, { maxPages: 3 }, h.deps);
    expect(r.from).toBeNull();
    expect(h.state().error).toBe("HL 429");
  });
});
