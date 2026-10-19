import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  AlertFeedbackInputSchema,
  AlertsQuerySchema,
  CatalystsQuerySchema,
  EventsQuerySchema,
  ManualCatalystInputSchema,
} from "../../../shared/intel.js";
import { addManualCatalyst, deleteManualCatalyst } from "../../intel/catalysts.js";
import type { IntelStore } from "../../intel/store.js";
import { toCatalyst } from "../../intel/terminal.js";
import { body, failure, invalid } from "./http.js";

// /api/intel alerts, events, catalysts and feedback (docs/SPEC.md § Intel I0.11–I0.13, I2).
// Session-cookie auth comes from the global gate. Mounted by the intel aggregator.
//
// GET    /alerts?since&kind          → {alerts} newest first
// POST   /alerts/:id/feedback {vote} → {alert}; vote 1 | -1
// GET    /events?since&type          → {events} newest first
// GET    /catalysts?days=14          → {catalysts} from 1 h ago to `days` ahead (1–60)
// POST   /catalysts                  manual → 201 {catalyst}; scheduledAt must be in the future
// DELETE /catalysts/:id              manual only (others → 400)
// GET    /feedback/report/latest     → {report: FeedbackReport | null}

export interface AlertsRouteDeps {
  store: Pick<
    IntelStore,
    "listAlerts" | "setAlertFeedback" | "listEvents" | "listCatalysts" | "upsertEvents" | "getEvent" | "deleteManualEvent" | "latestReport"
  >;
  /** Held ∪ watched assets (Catalyst.exposed). */
  targets(): Promise<string[]>;
  now?: () => Date;
}

const LIST_LIMIT = 200;
const RECENT_PAST_MS = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CatalystsDaysSchema = CatalystsQuerySchema.extend({ days: z.coerce.number().int().min(1).max(60).default(14) });

const id = (c: Context): string | null => {
  const v = c.req.param("id") ?? "";
  return UUID.test(v) ? v : null;
};

export function createAlertsRoutes(deps: AlertsRouteDeps) {
  const now = deps.now ?? (() => new Date());
  return new Hono()
    .get("/alerts", async (c) => {
      const q = AlertsQuerySchema.safeParse({ since: c.req.query("since"), kind: c.req.query("kind") });
      if (!q.success) return invalid(c, q.error, "query");
      try {
        const alerts = await deps.store.listAlerts({ since: q.data.since ? new Date(q.data.since) : undefined, kind: q.data.kind, limit: LIST_LIMIT });
        return c.json({ alerts });
      } catch (err) {
        return failure(c, err, "intel:alerts");
      }
    })
    .post("/alerts/:id/feedback", async (c) => {
      const alertId = id(c);
      if (!alertId) return c.json({ error: "invalid id", field: "id" }, 400);
      const parsed = AlertFeedbackInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error, "feedback");
      try {
        const alert = await deps.store.setAlertFeedback(alertId, parsed.data.vote);
        return alert ? c.json({ alert }) : c.json({ error: "alert not found" }, 404);
      } catch (err) {
        return failure(c, err, "intel:alerts");
      }
    })
    .get("/events", async (c) => {
      const q = EventsQuerySchema.safeParse({ since: c.req.query("since"), type: c.req.query("type") });
      if (!q.success) return invalid(c, q.error, "query");
      try {
        const events = await deps.store.listEvents({ since: q.data.since ? new Date(q.data.since) : undefined, type: q.data.type, limit: LIST_LIMIT });
        return c.json({ events });
      } catch (err) {
        return failure(c, err, "intel:alerts");
      }
    })
    .get("/catalysts", async (c) => {
      const q = CatalystsDaysSchema.safeParse({ days: c.req.query("days") });
      if (!q.success) return invalid(c, q.error, "query");
      try {
        const t = now().getTime();
        const [events, targets] = await Promise.all([
          deps.store.listCatalysts(new Date(t - RECENT_PAST_MS), new Date(t + q.data.days * 86_400_000)),
          deps.targets(),
        ]);
        const focus = new Set(targets);
        return c.json({ catalysts: events.map((e) => toCatalyst(e, focus)) });
      } catch (err) {
        return failure(c, err, "intel:alerts");
      }
    })
    .post("/catalysts", async (c) => {
      const parsed = ManualCatalystInputSchema.safeParse(await body(c));
      if (!parsed.success) return invalid(c, parsed.error, "catalyst");
      const at = now();
      if (Date.parse(parsed.data.scheduledAt) <= at.getTime()) return c.json({ error: "scheduledAt must be in the future", field: "scheduledAt" }, 400);
      try {
        const [event, targets] = await Promise.all([addManualCatalyst(deps.store, parsed.data, at), deps.targets()]);
        return c.json({ catalyst: toCatalyst(event, new Set(targets)) }, 201);
      } catch (err) {
        return failure(c, err, "intel:alerts");
      }
    })
    .delete("/catalysts/:id", async (c) => {
      const eventId = id(c);
      if (!eventId) return c.json({ error: "invalid id", field: "id" }, 400);
      try {
        const r = await deleteManualCatalyst(deps.store, eventId);
        if (r === "not_found") return c.json({ error: "catalyst not found" }, 404);
        if (r === "not_manual") return c.json({ error: "only manual catalysts can be deleted", field: "id" }, 400);
        return c.json({ deleted: true });
      } catch (err) {
        return failure(c, err, "intel:alerts");
      }
    })
    .get("/feedback/report/latest", async (c) => {
      try {
        return c.json({ report: await deps.store.latestReport("feedback_weekly") });
      } catch (err) {
        return failure(c, err, "intel:alerts");
      }
    });
}
