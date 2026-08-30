import { Hono } from "hono";
import { z } from "zod";
import * as db from "../db";
import { BranchConfigSchema } from "../../shared/schemas";
import type { BranchConfig } from "../../shared/types";
import { simulate, type DailyClose } from "../sim/engine";
import { runMonteCarlo } from "../sim/montecarlo";
import { backfillBranch } from "../sim/backfill";

const createBody = z.object({ name: z.string().min(1), config: BranchConfigSchema });
const updateBody = z.object({ name: z.string().min(1).optional(), config: BranchConfigSchema.optional() });

const STABLES = new Set(["USDC", "USDT"]);

async function loadCandlesByCoin(config: BranchConfig): Promise<Record<string, DailyClose[]>> {
  const coins = new Set(config.allocations.map((a) => a.coin));
  coins.add("BTC"); // always needed to build the grid + benchmark curve
  const out: Record<string, DailyClose[]> = {};
  for (const coin of coins) {
    if (STABLES.has(coin)) continue;
    const rows = await db.getCandles(coin, "1d", config.startDate);
    out[coin] = rows.map((r) => ({ ts: new Date(r.ts).getTime(), c: r.c }));
  }
  return out;
}

export const branchesRoutes = new Hono()
  .get("/", async (c) => {
    return c.json(await db.listBranches());
  })
  .post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const branch = await db.createBranch(parsed.data.name, parsed.data.config);
    return c.json(branch, 201);
  })
  .get("/:id", async (c) => {
    const branch = await db.getBranch(c.req.param("id"));
    if (!branch) return c.json({ error: "not found" }, 404);
    const cached = await db.getBranchResult(branch.id);
    return c.json({ ...branch, result: cached?.result ?? null });
  })
  .put("/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = updateBody.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const branch = await db.updateBranch(c.req.param("id"), parsed.data);
    if (!branch) return c.json({ error: "not found" }, 404);
    return c.json(branch);
  })
  .delete("/:id", async (c) => {
    if (!(await db.deleteBranch(c.req.param("id")))) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  })
  .post("/:id/run", async (c) => {
    const branch = await db.getBranch(c.req.param("id"));
    if (!branch) return c.json({ error: "not found" }, 404);
    const config = BranchConfigSchema.parse(branch.config);

    await backfillBranch(config);
    const candlesByCoin = await loadCandlesByCoin(config);
    const result = simulate(config, candlesByCoin);
    const montecarlo = config.scenario
      ? runMonteCarlo(config.scenario, config.allocations, result.stats.finalValue, Date.now())
      : undefined;
    const full = montecarlo ? { ...result, montecarlo } : result;

    await db.saveBranchResult(branch.id, full);
    return c.json(full);
  });
