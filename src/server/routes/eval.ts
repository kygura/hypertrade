import { Hono } from "hono";
import { z } from "zod";
import { buildEvalView, type EvalOptions } from "../eval/service.js";

// GET /eval?horizon=60&levels=BTC:58500,66000;ETH:1500&races=BTC:58500-66000
//
// The eval lab's live view (docs/EVAL.md §8): per asset (BTC, ETH, HYPE) today's regime, the simulated path fan with
// the odds of touching each level, and the champion specs' last year and current position. Read-only: it places no
// orders and changes no settings. Levels and races are the caller's (the UI passes the ones the operator watches).

const query = z.object({
  horizon: z.coerce.number().int().min(5).max(180).optional(),
  levels: z.string().max(400).optional(),
  races: z.string().max(400).optional(),
});

/** "BTC:58500,66000;ETH:1500" → { BTC: [58500, 66000], ETH: [1500] }. Unknown shapes are dropped. */
export function parseLevels(s: string | undefined): Record<string, number[]> | undefined {
  if (!s) return undefined;
  const out: Record<string, number[]> = {};
  for (const part of s.split(";")) {
    const [a, xs] = part.split(":");
    if (!a || !xs || !/^[A-Za-z]{2,10}$/.test(a)) continue;
    const v = xs.split(",").map(Number).filter((x) => Number.isFinite(x) && x > 0).slice(0, 12);
    if (v.length) out[a.toUpperCase()] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** "BTC:58500-66000,53700-74100" → { BTC: [[58500, 66000], [53700, 74100]] }. */
export function parseRaces(s: string | undefined): Record<string, Array<[number, number]>> | undefined {
  if (!s) return undefined;
  const out: Record<string, Array<[number, number]>> = {};
  for (const part of s.split(";")) {
    const [a, xs] = part.split(":");
    if (!a || !xs || !/^[A-Za-z]{2,10}$/.test(a)) continue;
    const v = xs
      .split(",")
      .map((r) => r.split("-").map(Number))
      .filter((r): r is [number, number] => r.length === 2 && r.every((x) => Number.isFinite(x) && x > 0) && r[0]! < r[1]!)
      .slice(0, 6);
    if (v.length) out[a.toUpperCase()] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function createEvalRoutes(build: (o: EvalOptions) => Promise<unknown> = (o) => buildEvalView(o)) {
  const app = new Hono();
  app.get("/", async (c) => {
    const q = query.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "bad query", issues: q.error.issues.map((i) => i.message) }, 400);
    try {
      return c.json(await build({ horizon: q.data.horizon, levels: parseLevels(q.data.levels), races: parseRaces(q.data.races) }));
    } catch (err) {
      console.error("[eval]", err);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });
  return app;
}

export const evalRoutes = createEvalRoutes();
