import type { Claim } from "../../shared/claims.js";
import type { Alert, CatalystWindow, IntelEvent, ManualCatalystInputSchema } from "../../shared/intel.js";
import type { z } from "zod";
import { hostLabel } from "./ingest/common.js";
import { assetExposure, deepLink, exposureHits, loadContext, MAGNITUDE_WEIGHT, pathText, type MapperDeps } from "./mapper.js";
import { sendIntel } from "./notify.js";
import type { IntelStore } from "./store.js";

// Catalyst alerts (SPEC.md § Intel I0.13). Scheduled events within the next
// 24 h alert once per window for every held/watched asset they reach (same
// graph walk as the mapper, no LLM): T−24 h when first seen more than an hour
// out, T−1 h inside the last hour. An event first seen inside the last hour
// only gets the T−1 h alert, so nothing is pushed twice in one run. Dedupe on
// (kind, event id, asset, window). Always pushed; the line is the event
// itself, `observed` with its source when that source has a URL and the
// event is not an estimate, else `hypothesis`.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type CatalystDeps = Omit<MapperDeps, "llm" | "pushMateriality">;

const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function countdown(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `in ${m}m` : `in ${Math.round(m / 60)}h`;
}

function catalystLine(e: IntelEvent, text: string): Claim {
  const src = e.sources.find((s) => s.url);
  return e.tag === "observed" && src ? { tag: "observed", text, source: { label: src.label, url: src.url }, ts: e.firstSeen } : { tag: "hypothesis", text };
}

export async function catalystAlerts(deps: CatalystDeps, now: Date): Promise<{ alerts: Alert[] }> {
  const t = now.getTime();
  const events = (await deps.store.listCatalysts(now, new Date(t + DAY_MS))).filter((e) => Date.parse(e.scheduledAt!) > t);
  if (!events.length) return { alerts: [] };
  const ctx = await loadContext(deps, false);
  const alerts: Alert[] = [];
  for (const e of events) {
    const until = Date.parse(e.scheduledAt!) - t;
    const window: CatalystWindow = until <= HOUR_MS ? "1h" : "24h";
    const inserted: Alert[] = [];
    for (const hit of exposureHits(ctx.edges, [...e.entities, ...e.assets], ctx.targets)) {
      const exp = await assetExposure(deps, ctx, hit.asset);
      const text = `${e.title} at ${utc(e.scheduledAt!)} (${countdown(until)}). ${exp.label}; exposed via ${pathText(hit)}.`.slice(0, 600);
      const alert = await deps.store.insertAlert({
        kind: "catalyst",
        ref: e.id,
        window,
        asset: hit.asset,
        title: e.title.slice(0, 300),
        eventType: e.type,
        line: catalystLine(e, text),
        path: hit.path,
        edgeType: hit.edgeType,
        hops: hit.hops,
        pathWeight: hit.pathWeight,
        sources: e.sources,
        materiality: MAGNITUDE_WEIGHT[e.magnitude] * hit.pathWeight * exp.weight * exp.proximity,
        pricedIn: null,
        route: "push",
      });
      if (alert) inserted.push(alert);
    }
    if (inserted.length) {
      await sendIntel(deps.notifier, { title: `T−${window}: ${e.title}`.slice(0, 200), lines: inserted.map((a) => a.line), link: deepLink(deps.appUrl) });
      alerts.push(...inserted);
    }
  }
  return { alerts };
}

export type ManualCatalyst = z.output<typeof ManualCatalystInputSchema>;

/** Stores an operator-entered catalyst as a manual event. URL-less entries are hypotheses (I0.7). */
export async function addManualCatalyst(store: Pick<IntelStore, "upsertEvents">, input: ManualCatalyst, now: Date): Promise<IntelEvent> {
  const catalyst = input.size || input.directionHypothesis ? { ...(input.size ? { size: input.size } : {}), ...(input.directionHypothesis ? { directionHypothesis: input.directionHypothesis } : {}) } : null;
  const [event] = await store.upsertEvents([
    {
      key: `manual:${crypto.randomUUID()}`,
      type: input.type,
      title: input.title,
      summary: null,
      entities: input.assets,
      assets: input.assets,
      magnitude: "med",
      sources: [input.url ? { label: hostLabel(input.url, "manual"), url: input.url } : { label: "manual" }],
      origin: "manual",
      firstSeen: now.toISOString(),
      scheduledAt: new Date(input.scheduledAt).toISOString(),
      catalyst,
      tag: input.url ? "observed" : "hypothesis",
    },
  ]);
  return event!;
}

/** Deletes a manual catalyst; anything else is refused. */
export async function deleteManualCatalyst(store: Pick<IntelStore, "getEvent" | "deleteManualEvent">, id: string): Promise<"deleted" | "not_found" | "not_manual"> {
  const e = await store.getEvent(id);
  if (!e) return "not_found";
  if (e.origin !== "manual") return "not_manual";
  return (await store.deleteManualEvent(id)) ? "deleted" : "not_found";
}
