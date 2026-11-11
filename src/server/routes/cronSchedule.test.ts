import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { app } from "../../../api/index.js";

// db/cron/schedule.sql must not drift from the code: every path it POSTs to is a real POST
// route behind the cron token, job names are unique, cron expressions parse, and no two HTTP
// jobs share a minute (pg_net batches requests queued together and runs them side by side).

process.env.CRON_TOKEN ??= "cron-schedule-test-token";

const sql = readFileSync(fileURLToPath(new URL("../../../db/cron/schedule.sql", import.meta.url)), "utf8");
const code = sql.replace(/--[^\n]*/g, "");

type Job = { name: string; expr: string; path?: string };

/** Rows of the job VALUES list: ('hypertrade-x', '<cron>', '/api/...', '<switch>'). */
const httpJobs: Job[] = [...code.matchAll(/\(\s*'(hypertrade-[^']*)'\s*,\s*'([^']*)'\s*,\s*'(\/api\/[^']*)'\s*,\s*'[^']*'\s*\)/g)].map(
  ([, name, expr, path]) => ({ name, expr, path }),
);
/** Literal cron.schedule('name', '<cron>', ...) calls. */
const literalJobs: Job[] = [...code.matchAll(/cron\.schedule\(\s*'([^']*)'\s*,\s*'([^']*)'/g)].map(([, name, expr]) => ({ name, expr }));
const jobs = [...httpJobs, ...literalJobs];

const FIELDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** Values a field matches, or null when it does not parse. `*`, `a`, `a-b`, any of them `/step`, comma lists. */
function expand(field: string, [lo, hi]: [number, number]): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    const from = m[1] === "*" ? lo : Number(m[2]);
    const to = m[1] === "*" ? hi : m[3] != null ? Number(m[3]) : m[4] != null ? hi : from;
    const step = m[4] != null ? Number(m[4]) : 1;
    if (from < lo || to > hi || from > to || step < 1) return null;
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return [...out];
}

/** pg_cron syntax: five standard fields, or `N seconds` (1–59) for sub-minute jobs. pg_cron has no six-field form. */
function validCron(expr: string): boolean {
  const s = expr.trim().match(/^(\d+) seconds?$/);
  if (s) return Number(s[1]) >= 1 && Number(s[1]) <= 59;
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f, i) => expand(f, FIELDS[i]) !== null);
}

describe("db/cron/schedule.sql", () => {
  test("parses the job list", () => {
    expect(httpJobs.length).toBeGreaterThanOrEqual(10);
    expect(literalJobs.map((j) => j.name)).toContain("hypertrade-cleanup");
  });

  test("job names are unique and prefixed", () => {
    const names = jobs.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^hypertrade-[a-z0-9-]+$/);
  });

  test("every cron expression is valid pg_cron syntax", () => {
    for (const j of jobs) expect({ job: j.name, valid: validCron(j.expr) }).toEqual({ job: j.name, valid: true });
  });

  test("no two HTTP jobs fire on the same minute", () => {
    const seen = new Map<number, string>();
    for (const j of httpJobs) {
      for (const m of expand(j.expr.split(/\s+/)[0], FIELDS[0]) ?? []) {
        expect({ minute: m, jobs: [seen.get(m), j.name].filter(Boolean) }).toEqual({ minute: m, jobs: [j.name] });
        seen.set(m, j.name);
      }
    }
  });

  test("the cron validator rejects bad expressions", () => {
    for (const bad of ["* * * *", "60 * * * *", "*/0 * * * *", "1-0 * * * *", "a * * * *", "0 0 0 * * *", "0 seconds"]) expect(validCron(bad)).toBe(false);
    for (const ok of ["*/15 * * * *", "0,15,30,45 * * * *", "33 3 * * *", "30 seconds", "0 9-17/2 * * 1-5"]) expect(validCron(ok)).toBe(true);
  });

  // Any /api/cron/* path answers 401 without the token, mounted or not (requireAuth gates the
  // prefix first), so the route table is the existence check and the 401 the auth check.
  const posts = new Set(app.routes.filter((r) => r.method === "POST" || r.method === "ALL").map((r) => r.path));
  for (const { name, path } of httpJobs) {
    test(`${name}: ${path} is a mounted POST route behind the cron token`, async () => {
      expect(posts.has(path!)).toBe(true);
      const res = await app.request(path!, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect([401, 403]).toContain(res.status);
    });
  }
});
