import { Hono } from "hono";
import { z } from "zod";
import { JournalQuerySchema, TradeIdSchema, TradeNoteInputSchema } from "../../../shared/intel.js";
import { loadJournal, putNote, tagStats, tagTrades, weeklyReport, type JournalDeps } from "../../intel/journal.js";
import { body, failure, invalid } from "./http.js";

// /journal — trade journal reviewer (docs/SPEC.md § Intel I0.15, I2). Mounted
// under /api/intel by the intel aggregator.
//
// GET  /journal?days=30            → {trades, stats, sources}
// PUT  /journal/:tradeId/note      {note} → TradeNote (empty note clears it)
// POST /journal/tag                {days?} → {tagged, failed, error?}
// GET  /journal/report/latest      → {report: JournalReport | null}
// POST /journal/report             {days?} → JournalReport (journal_weekly)

const TagBody = z.object({ days: JournalQuerySchema.shape.days }).strict();
const ReportBody = z.object({ days: z.number().int().min(1).max(90).default(7) }).strict();

export function createJournalRoutes(get: () => JournalDeps) {
  return new Hono()
    .get("/journal", async (c) => {
      const q = JournalQuerySchema.safeParse(c.req.query());
      if (!q.success) return invalid(c, q.error, "query");
      try {
        const { trades, sources } = await loadJournal(get(), q.data.days);
        return c.json({ trades, stats: tagStats(trades), sources });
      } catch (err) {
        return failure(c, err, "intel:journal");
      }
    })
    .put("/journal/:tradeId/note", async (c) => {
      const id = TradeIdSchema.safeParse(c.req.param("tradeId"));
      if (!id.success) return c.json({ error: "invalid trade id", field: "tradeId" }, 400);
      const b = TradeNoteInputSchema.safeParse(await body(c));
      if (!b.success) return invalid(c, b.error, "note");
      try {
        return c.json(await putNote(get().store, id.data, b.data.note));
      } catch (err) {
        return failure(c, err, "intel:journal");
      }
    })
    .post("/journal/tag", async (c) => {
      const b = TagBody.safeParse(await body(c));
      if (!b.success) return invalid(c, b.error, "request");
      const d = get();
      if (!d.llm.makeProvider("cheap")) return c.json({ error: "llm not configured" }, 503);
      try {
        const { trades } = await loadJournal(d, b.data.days);
        return c.json(await tagTrades(d, trades, c.req.raw.signal));
      } catch (err) {
        return failure(c, err, "intel:journal");
      }
    })
    .get("/journal/report/latest", async (c) => {
      try {
        return c.json({ report: await get().store.latestReport("journal_weekly") });
      } catch (err) {
        return failure(c, err, "intel:journal");
      }
    })
    .post("/journal/report", async (c) => {
      const b = ReportBody.safeParse(await body(c));
      if (!b.success) return invalid(c, b.error, "request");
      try {
        return c.json(await weeklyReport(get(), b.data.days, c.req.raw.signal));
      } catch (err) {
        return failure(c, err, "intel:journal");
      }
    });
}
