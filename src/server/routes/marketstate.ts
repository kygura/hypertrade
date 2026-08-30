import { Hono } from "hono";
import { MarketStateDataSchema } from "../../shared/schemas";
import latest from "../../../data/marketstate/latest.json";
import { MARKETSTATE_HISTORY } from "../../../data/marketstate/index";

export const marketstateRoutes = new Hono()
  .get("/", (c) => {
    const data = MarketStateDataSchema.parse(latest);
    return c.json({ ...data, history: MARKETSTATE_HISTORY.map((h) => h.date) });
  })
  .get("/history/:date", (c) => {
    const entry = MARKETSTATE_HISTORY.find((h) => h.date === c.req.param("date"));
    if (!entry) return c.json({ error: "not found" }, 404);
    return c.json(MarketStateDataSchema.parse(entry.data));
  });
