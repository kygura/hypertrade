import { describe, expect, test } from "bun:test";
import type { Observation, SyncState } from "../db.js";
import { collectLab, labAssets, labJobs, LAB_SYNC_COIN, OVERLAP_MS, REFRESH_MS, RETRY_MS, type LabCollectDeps, type LabJob } from "./collect.js";
import { HttpError } from "./providers/series.js";
import type { DailySeries, LabProvider, MetricDef } from "./types.js";

const D0 = Date.UTC(2024, 0, 1);
const DAY = 86_400_000;
const NOW = D0 + 3 * DAY + 12 * 3_600_000;

function memoryDeps() {
  const state = new Map<string, SyncState>();
  const rows: Observation[] = [];
  const chunks: number[] = [];
  const runs: Array<{ ok: boolean; error?: string | null }> = [];
  const deps: LabCollectDeps = {
    getSyncState: async (coin, series) => structuredClone(state.get(`${coin}/${series}`)) ?? { coin, series, hlFloor: null, ext: {}, syncedAt: null, accessedAt: null, error: null },
    saveSyncState: async (s) => void state.set(`${s.coin}/${s.series}`, structuredClone(s)),
    ensureSeries: async () => {},
    upsertObservations: async (r) => (chunks.push(r.length), rows.push(...r), r.length),
    recordCollectorRun: async (_c, _s, ok, error) => void runs.push({ ok, error }),
  };
  return { deps, state, rows, chunks, runs };
}

type Call = { id: string; key: string; asset: string; since: number | null; at: number; deadline?: number };

/** Providers whose history is `days(n)`; `fail` maps a key to the error its history throws. */
function fakeProviders(calls: Call[], opts: { fail?: Record<string, Error>; n?: number; active?: { cm: number; max: number }; partial?: Record<string, number> } = {}): LabProvider[] {
  const mk = (id: string, defs: Array<[string, "asset" | "global"]>): LabProvider =>
    ({
      id,
      name: id,
      notes: "",
      metrics: (): MetricDef[] => defs.map(([key, scope]) => ({ id: `${id}:${key}`, provider: id, key, name: key, category: "onchain", scope, description: key, lagDays: 1 })),
      fetch: async () => ({ t: [], v: [] }),
      async history(key: string, asset: string, since: number | null, o?: { deadline?: number }): Promise<DailySeries & { partial?: boolean }> {
        calls.push({ id, key, asset, since, at: calls.length, deadline: o?.deadline });
        if (opts.active && id === "cm") opts.active.max = Math.max(opts.active.max, ++opts.active.cm);
        await Promise.resolve();
        if (opts.active && id === "cm") opts.active.cm--;
        const err = opts.fail?.[key];
        if (err) throw err;
        const all = Array.from({ length: opts.n ?? 4 }, (_, i) => D0 + i * DAY);
        // `partial[key]` days per call, from `since` on, cut short like a paged history at its deadline.
        const cut = opts.partial?.[key];
        const t = cut === undefined ? all : all.filter((x) => x >= (since ?? -Infinity)).slice(0, cut);
        const series = { t, v: t.map((x) => (x - D0) / DAY + 1) };
        return cut !== undefined && t.length === cut && t[t.length - 1] !== all[all.length - 1] ? { ...series, partial: true } : series;
      },
    }) as LabProvider;
  return [
    mk("cm", [
      ["CapMVRVCur", "asset"],
      ["TxCnt", "asset"],
    ]),
    mk("bc", [["hash_rate", "global"]]),
    mk("deribit", [["btc_dvol", "global"]]),
    // Not collectable: never part of a job.
    { id: "ht", name: "ht", notes: "", metrics: () => [{ id: "ht:price", provider: "ht", key: "price", name: "p", category: "price", scope: "asset", description: "", lagDays: 0 }], fetch: async () => ({ t: [], v: [] }) },
  ];
}

const run = (m: ReturnType<typeof memoryDeps>, jobs: LabJob[], now: number, extra: Partial<Parameters<typeof collectLab>[1]> = {}) =>
  collectLab(m.deps, { jobs, now: () => now, sleep: async () => {}, ...extra });

describe("labJobs", () => {
  test("asset metrics per asset, globals once, non-collectable providers skipped", () => {
    const ids = labJobs(fakeProviders([]), ["BTC", "ETH"]).map((j) => j.id);
    expect(ids).toEqual(["lab.cm.CapMVRVCur.btc", "lab.cm.CapMVRVCur.eth", "lab.cm.TxCnt.btc", "lab.cm.TxCnt.eth", "lab.bc.hash_rate", "lab.deribit.btc_dvol"]);
  });

  test("the real catalogue: cm × assets, fng, llama ×2, bc ×4, deribit ×2; own namespace", () => {
    const ids = labJobs(undefined, ["BTC", "ETH"]).map((j) => j.id);
    expect(ids).toHaveLength(12 * 2 + 1 + 2 + 4 + 2);
    for (const id of ["lab.cm.CapMVRVCur.eth", "lab.fng.value", "lab.llama.stablecoin_cap", "lab.bc.hash_rate", "lab.deribit.eth_dvol"]) expect(ids).toContain(id);
    expect(ids.every((id) => id.startsWith("lab."))).toBe(true);
  });

  test("LAB_ASSETS", () => {
    expect(labAssets({})).toEqual(["BTC", "ETH"]);
    expect(labAssets({ LAB_ASSETS: " sol, btc,,SOL, bad-one " })).toEqual(["SOL", "BTC"]);
  });
});

describe("collectLab", () => {
  test("first run pulls full history for every series and records the sync", async () => {
    const calls: Call[] = [];
    const m = memoryDeps();
    const res = await run(m, labJobs(fakeProviders(calls), ["BTC"]), NOW);
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.sources).toEqual({ "lab.cm.CapMVRVCur.btc": "ok", "lab.cm.TxCnt.btc": "ok", "lab.bc.hash_rate": "ok", "lab.deribit.btc_dvol": "ok" });
    expect(calls.every((c) => c.since === null)).toBe(true);
    // days 0..3 come back; day 3 is today (still forming) and is not stored
    expect(res.written).toBe(12);
    expect(m.rows.filter((r) => r.seriesId === "lab.bc.hash_rate").map((r) => r.value)).toEqual([1, 2, 3]);
    expect(m.state.get(`${LAB_SYNC_COIN}/lab.cm.TxCnt.btc`)?.syncedAt).toBe(NOW);
    expect(m.runs).toEqual([{ ok: true, error: null }]);
  });

  test("inside the refresh window nothing is fetched", async () => {
    const m = memoryDeps();
    await run(m, labJobs(fakeProviders([]), ["BTC"]), NOW);
    const calls: Call[] = [];
    const res = await run(m, labJobs(fakeProviders(calls), ["BTC"]), NOW + REFRESH_MS - 1);
    expect(calls).toEqual([]);
    expect(Object.values(res.sources).every((s) => s === "skipped")).toBe(true);
  });

  test("later runs fetch a tail from the last sync minus a week and keep only that", async () => {
    const m = memoryDeps();
    const first = NOW + 7 * DAY; // day 10, noon
    await run(m, labJobs(fakeProviders([], { n: 12 }), ["BTC"]), first);
    const calls: Call[] = [];
    const before = m.rows.length;
    const res = await run(m, labJobs(fakeProviders(calls, { n: 12 }), ["BTC"]), first + REFRESH_MS);
    expect(calls.every((c) => c.since === first - OVERLAP_MS)).toBe(true);
    // days 0..11 come back; only days 4..10 are ≥ day 3 noon and before today (day 11)
    expect(m.rows.length - before).toBe(4 * 7);
    expect(res.written).toBe(4 * 7);
  });

  test("one failing source does not stop the rest; its error is recorded", async () => {
    const m = memoryDeps();
    const res = await run(m, labJobs(fakeProviders([], { fail: { hash_rate: new Error("HTTP 503") } }), ["BTC"]), NOW);
    expect(res.ok).toBe(true);
    expect(res.sources["lab.bc.hash_rate"]).toBe("error");
    expect(res.sources["lab.deribit.btc_dvol"]).toBe("ok");
    expect(res.error).toBe("lab.bc.hash_rate: HTTP 503");
    const st = m.state.get(`${LAB_SYNC_COIN}/lab.bc.hash_rate`)!;
    expect(st.syncedAt).toBeNull();
    expect(st.error).toContain("503");
  });

  test("a failed series backs off an hour; a refusal (4xx) a full refresh", async () => {
    const m = memoryDeps();
    const fail = { hash_rate: new Error("HTTP 503"), btc_dvol: new HttpError("deribit: HTTP 400", 400) };
    await run(m, labJobs(fakeProviders([], { fail }), ["BTC"]), NOW);
    const soon: Call[] = [];
    await run(m, labJobs(fakeProviders(soon), ["BTC"]), NOW + RETRY_MS - 1);
    expect(soon.map((c) => c.key)).toEqual([]);
    const later: Call[] = [];
    await run(m, labJobs(fakeProviders(later), ["BTC"]), NOW + RETRY_MS + 1);
    expect(later.map((c) => c.key)).toEqual(["hash_rate"]);
    expect(later[0]!.since).toBeNull(); // never synced: still a full backfill
    expect(m.state.get(`${LAB_SYNC_COIN}/lab.bc.hash_rate`)?.error).toBeNull();
    const day: Call[] = [];
    await run(m, labJobs(fakeProviders(day), ["BTC"]), NOW + REFRESH_MS + 1);
    expect(day.map((c) => c.key)).toContain("btc_dvol");
  });

  test("an empty first backfill is an error, not a sync", async () => {
    const m = memoryDeps();
    const res = await run(m, labJobs(fakeProviders([], { n: 0 }), ["BTC"]), NOW);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no history returned");
    expect(m.runs).toEqual([{ ok: false, error: res.error }]);
  });

  test("a passed deadline skips series instead of starting them", async () => {
    const calls: Call[] = [];
    const res = await run(memoryDeps(), labJobs(fakeProviders(calls), ["BTC"]), NOW, { deadline: NOW - 1 });
    expect(calls).toEqual([]);
    expect(res.ok).toBe(true);
    expect(Object.values(res.sources).every((s) => s === "skipped")).toBe(true);
  });

  test("Coin Metrics goes one request at a time with a pause; others in parallel", async () => {
    const calls: Call[] = [];
    const active = { cm: 0, max: 0 };
    const sleeps: number[] = [];
    await run(memoryDeps(), labJobs(fakeProviders(calls, { active }), ["BTC", "ETH"]), NOW, { sleep: async (ms) => void sleeps.push(ms) });
    expect(calls.filter((c) => c.id === "cm")).toHaveLength(4);
    expect(active.max).toBe(1);
    expect(sleeps).toEqual([700, 700, 700, 700]);
  });

  test("writes in chunks of 5000, oldest first", async () => {
    const m = memoryDeps();
    const jobs = labJobs(fakeProviders([], { n: 12_000 }), ["BTC"]).filter((j) => j.id === "lab.bc.hash_rate");
    await run(m, jobs, D0 + 13_000 * DAY);
    expect(m.chunks).toEqual([5000, 5000, 2000]);
    expect(m.rows[0]!.ts).toEqual(new Date(D0));
  });

  test("an unreadable sync_state fails that series only", async () => {
    const m = memoryDeps();
    const deps = { ...m.deps, getSyncState: async (c: string, s: string) => (s.includes("cm") ? Promise.reject(new Error("db down")) : m.deps.getSyncState(c, s)) };
    const res = await collectLab(deps, { jobs: labJobs(fakeProviders([]), ["BTC"]), now: () => NOW, sleep: async () => {} });
    expect(res.sources["lab.cm.TxCnt.btc"]).toBe("error");
    expect(res.sources["lab.bc.hash_rate"]).toBe("ok");
    expect(res.ok).toBe(true);
  });

  test("passes the budget to history as its deadline", async () => {
    const calls: Call[] = [];
    await run(memoryDeps(), labJobs(fakeProviders(calls), ["BTC"]), NOW, { deadline: NOW + 1000 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.deadline === NOW + 1000)).toBe(true);
  });

  test("a history cut short by the deadline is stored, not marked synced, and resumed next run", async () => {
    const m = memoryDeps();
    const jobs = (calls: Call[]) => labJobs(fakeProviders(calls, { n: 10, partial: { hash_rate: 4 } }), ["BTC"]).filter((j) => j.id === "lab.bc.hash_rate");
    const at = D0 + 10 * DAY + 3_600_000;
    const first = await run(m, jobs([]), at);
    expect(first.sources["lab.bc.hash_rate"]).toBe("partial");
    expect(first.ok).toBe(true);
    const st = m.state.get(`${LAB_SYNC_COIN}/lab.bc.hash_rate`)!;
    expect(st.syncedAt).toBeNull();
    expect(st.error).toBeNull();
    expect(m.rows.map((r) => r.value)).toEqual([1, 2, 3, 4]);
    // Next run (even minutes later) resumes from the last stored day.
    const calls: Call[] = [];
    await run(m, jobs(calls), at + 60_000);
    expect(calls[0]!.since).toBe(D0 + 3 * DAY);
    const done = await run(m, jobs([]), at + 120_000);
    expect(done.sources["lab.bc.hash_rate"]).toBe("ok");
    expect(m.state.get(`${LAB_SYNC_COIN}/lab.bc.hash_rate`)!.syncedAt).toBe(at + 120_000);
    expect(m.state.get(`${LAB_SYNC_COIN}/lab.bc.hash_rate`)!.ext as unknown).toEqual({ lab: { attemptedAt: at + 120_000 } });
    expect([...new Set(m.rows.map((r) => r.value))].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
