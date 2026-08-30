import { Hono } from "hono";
import * as db from "../db";
import { backfillCoin } from "../sim/backfill";

const DAY_MS = 86400000;
const DEFAULT_LOOKBACK_DAYS = 365;

export const candlesRoutes = new Hono().get("/:coin", async (c) => {
  const coin = c.req.param("coin").toUpperCase();
  const tf = c.req.query("tf") ?? "1d";
  const from = c.req.query("from");
  const startDate = from ? new Date(from) : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * DAY_MS);

  if (tf === "1d") await backfillCoin(coin, startDate); // fills gaps before serving

  return c.json(await db.getCandles(coin, tf, startDate));
});
