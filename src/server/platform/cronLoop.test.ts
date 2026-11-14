import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COVERED_BY_LOOPS, IN_PROCESS_JOBS, createCronLoop } from "./cronLoop";

// The in-process cron is a second path for the jobs in db/cron/schedule.sql, so it keeps parity with it: every HTTP
// job there is either run here at the same minutes and path, or done by a worker loop in scripts/server.ts.

const sql = readFileSync(fileURLToPath(new URL("../../../db/cron/schedule.sql", import.meta.url)), "utf8").replace(/--[^\n]*/g, "");
const rows = [...sql.matchAll(/\(\s*'(hypertrade-[^']*)'\s*,\s*'([^']*)'\s*,\s*'(\/api\/[^']*)'\s*,\s*'([^']*)'\s*\)/g)].map(
  ([, name, expr, path, sw]) => ({ name, expr, path, sw }),
);

describe("in-process cron vs db/cron/schedule.sql", () => {
  test("every HTTP job is run in process or covered by a worker loop, not both", () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const inProcess = new Set(IN_PROCESS_JOBS.map((j) => j.name));
    for (const r of rows) {
      const where = [inProcess.has(r.name) && "cron", COVERED_BY_LOOPS.includes(r.name) && "loops"].filter(Boolean);
      expect({ job: r.name, where }).toEqual({ job: r.name, where: [where[0] ?? "nowhere"] });
    }
    const names = new Set(rows.map((r) => r.name));
    for (const n of [...inProcess, ...COVERED_BY_LOOPS]) expect({ job: n, inSchedule: names.has(n) }).toEqual({ job: n, inSchedule: true });
  });

  test("same minutes, path and intel switch", () => {
    for (const j of IN_PROCESS_JOBS) {
      const r = rows.find((x) => x.name === j.name)!;
      const [min, ...rest] = r.expr.trim().split(/\s+/);
      expect({ job: j.name, rest: rest.join(" ") }).toEqual({ job: j.name, rest: "* * * *" });
      expect({ job: j.name, minutes: min.split(",").map(Number) }).toEqual({ job: j.name, minutes: [...j.minutes] });
      expect({ job: j.name, path: j.path, intel: Boolean(j.intel) }).toEqual({ job: j.name, path: r.path, intel: r.sw === "intel" });
    }
  });
});

describe("createCronLoop", () => {
  const at = (iso: string) => () => new Date(iso);
  const setup = (opts: { intel?: boolean; status?: number; hold?: Promise<void> } = {}) => {
    const calls: { path: string; token: string | null; method: string }[] = [];
    let clock = new Date("2026-11-14T10:00:05Z");
    const loop = createCronLoop({
      token: "tok",
      intel: opts.intel,
      now: () => clock,
      log: () => {},
      fetch: async (req) => {
        calls.push({ path: new URL(req.url).pathname, token: req.headers.get("x-cron-token"), method: req.method });
        await opts.hold;
        return new Response("{}", { status: opts.status ?? 200 });
      },
    });
    return { loop, calls, set: (iso: string) => void (clock = new Date(iso)) };
  };

  test("fires the jobs due in a minute once, with the cron token", async () => {
    const { loop, calls, set } = setup();
    await loop.def.run();
    await loop.def.run(); // same minute: nothing new
    await loop.drain();
    expect(calls).toEqual([{ path: "/api/cron/collect", token: "tok", method: "POST" }]);
    set("2026-11-14T10:01:00Z");
    await loop.def.run();
    await loop.drain();
    expect(calls.length).toBe(1);
    set("2026-11-14T10:14:30Z");
    await loop.def.run();
    await loop.drain();
    expect(calls.map((c) => c.path)).toEqual(["/api/cron/collect", "/api/cron/intel/brief"]);
  });

  test("INTEL_ENABLED=false leaves the intel jobs out", async () => {
    const { loop, calls, set } = setup({ intel: false });
    set("2026-11-14T10:12:00Z");
    await loop.def.run();
    await loop.drain();
    expect(calls).toEqual([]);
  });

  test("a job still running when its next minute comes is not queued twice, and jobs run one at a time", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { loop, calls, set } = setup({ hold });
    await loop.def.run(); // 10:00 collect starts and blocks
    set("2026-11-14T10:02:00Z");
    await loop.def.run(); // backfill queued behind it
    set("2026-11-14T10:15:00Z");
    await loop.def.run(); // collect again: still running, skipped
    await Promise.resolve();
    expect(calls.map((c) => c.path)).toEqual(["/api/cron/collect"]);
    release();
    await loop.drain();
    expect(calls.map((c) => c.path)).toEqual(["/api/cron/collect", "/api/cron/backfill"]);
  });

  test("a failed job shows as the loop's error on the next check", async () => {
    const { loop, set } = setup({ status: 500 });
    await loop.def.run();
    await loop.drain();
    set("2026-11-14T10:00:30Z");
    await expect(loop.def.run()).rejects.toThrow(/hypertrade-collect: HTTP 500/);
    await loop.def.run(); // reported once
  });

  test("refuses to run without CRON_TOKEN", async () => {
    const loop = createCronLoop({ token: "", fetch: () => new Response("{}"), now: at("2026-11-14T10:00:00Z"), log: () => {} });
    await expect(loop.def.run()).rejects.toThrow(/needs CRON_TOKEN/);
  });
});
