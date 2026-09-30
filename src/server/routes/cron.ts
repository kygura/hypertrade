import { Hono } from "hono";
import { requireCronToken } from "../auth.js";
import { collectCryptoContext } from "../collectors/cryptoContext.js";
import { collectFred } from "../collectors/fred.js";
import { collectHyperliquid } from "../collectors/hyperliquid.js";

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
