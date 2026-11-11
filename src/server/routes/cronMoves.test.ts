import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { cronMovesRoutes, MOVES_CRON_LEASE_MS, NO_DATABASE, runMovesCron, type CronMovesDeps } from "./cronMoves.js";

process.env.CRON_TOKEN = "test-cron-token";

function deps(o: Partial<CronMovesDeps> & { held?: boolean } = {}) {
  const calls: string[] = [];
  const leases: Array<{ job: string; ttl: number }> = [];
  const released: string[] = [];
  const d: CronMovesDeps = {
    hasDb: () => true,
    lease: (job) => ({
      acquire: async (_h, ttl) => (leases.push({ job, ttl }), !o.held),
      release: async () => void released.push(job),
    }),
    run: {
      moves: async () => (calls.push("moves"), { saved: ["4h", "24h", "72h"] }),
      "moves-agent": async () => (calls.push("moves-agent"), { surfaced: 2, graded: 1, investigated: null, investigation: "no LLM provider configured" }),
    },
    now: () => 0,
    ...o,
  };
  return { d, calls, leases, released };
}

const post = (app: Hono, path: string, headers: Record<string, string> = { "x-cron-token": "test-cron-token" }) => app.request(path, { method: "POST", headers });

describe("POST /cron/moves and /cron/moves-agent", () => {
  test("the cron token is required (x-cron-token); nothing runs without it", async () => {
    const { d, calls } = deps();
    const app = new Hono().route("/cron", cronMovesRoutes(() => d));
    expect((await post(app, "/cron/moves", {})).status).toBe(401);
    expect((await post(app, "/cron/moves-agent", { "x-cron-token": "wrong" })).status).toBe(401);
    expect(calls).toEqual([]);
    const res = await post(app, "/cron/moves");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ job: "moves", ok: true, result: { saved: ["4h", "24h", "72h"] } });
    expect((await (await post(app, "/cron/moves-agent")).json()) as object).toMatchObject({ job: "moves-agent", ok: true, result: { surfaced: 2 } });
    expect(calls).toEqual(["moves", "moves-agent"]);
  });

  test("an overlapping call skips under the lease; the run releases its own", async () => {
    const held = deps({ held: true });
    expect(await runMovesCron("moves", held.d)).toEqual({ status: 200, body: { job: "moves", ok: true, skipped: "leased" } });
    expect(held.calls).toEqual([]);
    const free = deps();
    await runMovesCron("moves-agent", free.d);
    expect(free.leases).toEqual([{ job: "moves-agent", ttl: MOVES_CRON_LEASE_MS }]);
    expect(free.released).toEqual(["moves-agent"]);
  });

  test("503 with the reason without a database; nothing is leased or run", async () => {
    const { d, calls, leases } = deps({ hasDb: () => false });
    const app = new Hono().route("/cron", cronMovesRoutes(() => d));
    const res = await post(app, "/cron/moves");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ job: "moves", error: "unavailable", reason: NO_DATABASE });
    expect([calls, leases]).toEqual([[], []]);
  });

  test("a thrown run is a 500 body; a run past the hard stop answers timedOut and still frees its lease", async () => {
    const boom = deps({ run: { moves: async () => Promise.reject(new Error("db down")), "moves-agent": async () => null } });
    expect(await runMovesCron("moves", boom.d)).toEqual({ status: 500, body: { job: "moves", ok: false, error: "db down" } });
    expect(boom.released).toEqual(["moves"]);

    let finish!: () => void;
    const slow = deps({ hardStopMs: 5, run: { moves: () => new Promise<void>((r) => (finish = r)), "moves-agent": async () => null } });
    const r = await runMovesCron("moves", slow.d);
    expect(r).toMatchObject({ status: 500, body: { timedOut: true } });
    expect(slow.released).toEqual([]);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(slow.released).toEqual(["moves"]);
  });
});
