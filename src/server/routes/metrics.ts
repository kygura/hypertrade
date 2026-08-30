import { Hono } from "hono";
import { z } from "zod";
import { seriesRange, summaryFor } from "../db";

const summaryQuery = z.object({ ids: z.string().min(1) });

const seriesQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  buckets: z.coerce.number().int().positive().optional(),
});

export const metricsRoutes = new Hono()
  .get("/summary", async (c) => {
    const parsed = summaryQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query" }, 400);
    const ids = parsed.data.ids.split(",").map((s) => s.trim()).filter(Boolean);
    return c.json(await summaryFor(ids));
  })
  .get("/series/:id", async (c) => {
    const parsed = seriesQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid query" }, 400);
    const { from, to, buckets } = parsed.data;
    return c.json(await seriesRange(c.req.param("id"), from, to, buckets));
  });
