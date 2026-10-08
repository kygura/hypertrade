import { Hono } from "hono";
import { z } from "zod";
import * as db from "../db.js";
import { BranchConfigSchema } from "../../shared/schemas.js";
import { NoPriceDataError } from "../sim/engine.js";
import { runBranchConfig } from "../sim/run.js";

const createBody = z.object({ name: z.string().min(1), config: BranchConfigSchema });
const updateBody = z.object({ name: z.string().min(1).optional(), config: BranchConfigSchema.optional() });

/** Normalizes a zod failure into the {error: string, details} shape every
 * other route uses — "invalid config" when only the nested config field
 * failed, "invalid body" otherwise. */
function invalidBody(error: z.ZodError) {
  const flat = error.flatten();
  const keys = Object.keys(flat.fieldErrors);
  const errorMsg = keys.length === 1 && keys[0] === "config" ? "invalid config" : "invalid body";
  return { error: errorMsg, details: flat };
}

export const branchesRoutes = new Hono()
  .get("/", async (c) => {
    return c.json(await db.listBranches());
  })
  .post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = createBody.safeParse(body);
    if (!parsed.success) return c.json(invalidBody(parsed.error), 400);
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
    if (!parsed.success) return c.json(invalidBody(parsed.error), 400);
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
    const parsed = BranchConfigSchema.safeParse(branch.config);
    if (!parsed.success) return c.json({ error: "stored config is invalid", details: parsed.error.flatten() }, 422);
    const config = parsed.data;

    let full;
    try {
      full = await runBranchConfig(config);
    } catch (err) {
      if (err instanceof NoPriceDataError) return c.json({ error: err.message }, 422);
      throw err;
    }

    await db.saveBranchResult(branch.id, full);
    return c.json(full);
  });
