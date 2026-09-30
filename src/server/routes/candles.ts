import { Hono } from "hono";
import { z } from "zod";
import * as db from "../db.js";
import { backfillCoin } from "../sim/backfill.js";

const DAY_MS = 86400000;
const DEFAULT_LOOKBACK_DAYS = 365;

// Keep in sync with shared/hl-client.ts's CandleInterval union.
const TF_VALUES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;

const querySchema = z.object({
  tf: z.enum(TF_VALUES).optional(),
  from: z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid date" }).optional(),
});

export const candlesRoutes = new Hono().get("/:coin", async (c) => {
  const coin = c.req.param("coin").toUpperCase();
  const parsed = querySchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "invalid query" }, 400);
  const tf = parsed.data.tf ?? "1d";
  const from = parsed.data.from;
  const startDate = from ? new Date(from) : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * DAY_MS);

  if (tf === "1d") await backfillCoin(coin, startDate); // fills gaps before serving

  return c.json(await db.getCandles(coin, tf, startDate));
});
