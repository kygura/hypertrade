import { Hono } from "hono";
import { requireCronToken } from "../auth";
import { collectCryptoContext } from "../collectors/cryptoContext";
import { collectFred } from "../collectors/fred";
import { collectHyperliquid } from "../collectors/hyperliquid";

// Safe to call repeatedly: observations PK (series_id, ts) dedupes upserts,
// and each collector run is independent — a re-trigger just overwrites the
// same timestamp's values.
export const cronRoutes = new Hono().post("/collect", requireCronToken, async (c) => {
  const [hyperliquid, cryptoContext, fred] = await Promise.all([
    collectHyperliquid(),
    collectCryptoContext(),
    collectFred(),
  ]);
  return c.json({ hyperliquid, cryptoContext, fred });
});
