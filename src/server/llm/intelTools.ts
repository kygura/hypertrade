import { z } from "zod";
import { AlertKindSchema, BriefSurfaceSchema, type Alert, type Brief, type PositionsResponse, type Thesis } from "../../shared/intel.js";
import { FeedRowSchema, OpportunityStatusSchema, type FeedRow } from "../../shared/platform.js";
import type { IntelStore } from "../intel/store.js";
import type { PlatformStore } from "../platform/store.js";
import type { ToolSpec } from "./provider.js";

// Read tools over the Intel and Platform data the Cockpit and Terminal show:
// opportunities, alerts, the latest brief, exposure, theses. Shared by the
// analyst and the desk agents (desk/tools.ts reuses the analyst registry).
//
// Everything arrives through IntelReadDeps, never by import: intel already
// imports desk/tools.ts, so a value import of the stores here would be a cycle.
// Only types are imported above (erased at runtime). routes/agentData.ts builds
// the production deps. Tools are read-only; each caps rows and fields so a
// round stays small.

/** Data access the intel/platform tools need; injectable so tests run on the memory stores. */
export interface IntelReadDeps {
  now(): Date;
  /** Platform feed, highest score first; [] when the platform store is not configured. */
  opportunities(o: { statuses?: FeedRow["status"][]; limit: number }): Promise<FeedRow[]>;
  alerts(o: { since: Date; kind?: Alert["kind"]; limit: number }): Promise<Alert[]>;
  latestBrief(surface?: Brief["surface"]): Promise<Brief | null>;
  exposure(): Promise<PositionsResponse>;
  theses(): Promise<Thesis[]>;
}

/** The deps over the real stores, or their memory twins in tests. `platform` is null when no platform store is configured. */
export function intelReadDeps(o: {
  intel: Pick<IntelStore, "listAlerts" | "latestBrief" | "listTheses">;
  platform: () => Pick<PlatformStore, "listOpportunities"> | null;
  exposure: () => Promise<PositionsResponse>;
  now?: () => Date;
}): IntelReadDeps {
  return {
    now: o.now ?? (() => new Date()),
    opportunities: async ({ statuses, limit }) => {
      const store = o.platform();
      if (!store) throw new Error("platform offline");
      return (await store.listOpportunities({ statuses, limit })).map((r) => FeedRowSchema.parse(r));
    },
    alerts: ({ since, kind, limit }) => o.intel.listAlerts({ since, kind, limit }),
    latestBrief: (surface) => o.intel.latestBrief(surface),
    exposure: o.exposure,
    theses: () => o.intel.listTheses(),
  };
}

let registered: IntelReadDeps | null = null;
/** Set once at boot by routes/agentData.ts; the analyst and desk default deps read it lazily. */
export const registerIntelReadDeps = (d: IntelReadDeps | null) => {
  registered = d;
};
/** A stand-in that resolves the registered deps per call, so building defaultToolDeps stays free of I/O and order. */
export const registeredIntelReadDeps: IntelReadDeps = {
  now: () => (registered ?? { now: () => new Date() }).now(),
  opportunities: (o) => need().opportunities(o),
  alerts: (o) => need().alerts(o),
  latestBrief: (s) => need().latestBrief(s),
  exposure: () => need().exposure(),
  theses: () => need().theses(),
};
function need(): IntelReadDeps {
  if (!registered) throw new Error("intel data is not connected to this process");
  return registered;
}

export interface IntelToolRun {
  content: string;
  summary: string;
  isError: boolean;
}

const MAX_CHARS = 12_000;
const clip = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s.length <= MAX_CHARS ? s : `${s.slice(0, MAX_CHARS)}…[truncated ${s.length - MAX_CHARS} chars]`;
};
const ok = (v: unknown, summary: string): IntelToolRun => ({ content: clip(v), summary, isError: false });

export const INTEL_TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_opportunities",
    description:
      "The platform scanner's opportunity feed (what the Cockpit shows), highest score first: coin, direction, setup kind, status (new, investigating, calculated, ready, approved, rejected, expired, open, closed, failed), score, net edge in bps and its basis, liquidity tier, tags. Use status 'ready' for what is actionable now. Read-only; approving or rejecting is the operator's.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "array", items: { type: "string", enum: OpportunityStatusSchema.options }, maxItems: 10, description: "filter by status; omit for all" },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "default 10" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_alerts",
    description:
      "Recent Intel alerts, newest first: kind (mapper, catalyst, docwatch, terminal, flow, narrative), asset, title, the claim-tagged line, materiality 0-1, route (push or batch) and sources. Alerts are rare and informational.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: AlertKindSchema.options },
        hours: { type: "integer", minimum: 1, maximum: 168, description: "look-back window, default 48" },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "default 10" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_intel_brief",
    description:
      "The latest stored Intel Terminal brief ('what changed for my book'): baseline time, the narrated lines, the top ranked changes (asset, metric, from, to, z, materiality), batched alerts and upcoming catalysts. Does not compute a new brief. brief is null when none exists; silent means nothing cleared the thresholds.",
    input_schema: { type: "object", properties: { surface: { type: "string", enum: BriefSurfaceSchema.options, description: "ui or cron; omit for either" } }, additionalProperties: false },
  },
  {
    name: "get_exposure",
    description:
      "The operator's unified positions (manual, Hyperliquid address, desk book): asset, side, size, entry, mark, stop, leverage, notional USD, unrealized PnL, plus total notional and per-source health.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_theses",
    description:
      "The operator's saved theses, newest first: text, assets, each claim or assumption with its supported/contradicted/unknown status, invalidation conditions with their status, and when it was last checked.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 10, description: "default 5" } },
      additionalProperties: false,
    },
  },
];

export const intelInputs = {
  get_opportunities: z.object({ status: z.array(OpportunityStatusSchema).max(10).optional(), limit: z.number().int().min(1).max(25).optional() }).strict(),
  get_alerts: z
    .object({ kind: AlertKindSchema.optional(), hours: z.number().int().min(1).max(168).optional(), limit: z.number().int().min(1).max(25).optional() })
    .strict(),
  get_intel_brief: z.object({ surface: BriefSurfaceSchema.optional() }).strict(),
  get_exposure: z.object({}).strict(),
  get_theses: z.object({ limit: z.number().int().min(1).max(10).optional() }).strict(),
} as const;

export type IntelToolName = keyof typeof intelInputs;
export const isIntelTool = (name: string): name is IntelToolName => name in intelInputs;

const text = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const alertRow = (a: Alert) => ({
  id: a.id, kind: a.kind, asset: a.asset, title: text(a.title, 200), line: a.line, materiality: a.materiality, route: a.route,
  window: a.window, sources: a.sources.slice(0, 2), createdAt: a.createdAt,
});

/** Runs one intel tool on already-parsed input. Throws on a data failure; runTool in tools.ts turns that into an error result. */
export async function runIntelTool(name: IntelToolName, input: z.infer<(typeof intelInputs)[IntelToolName]>, deps: IntelReadDeps): Promise<IntelToolRun> {
  switch (name) {
    case "get_opportunities": {
      const i = input as z.infer<typeof intelInputs.get_opportunities>;
      const rows = await deps.opportunities({ statuses: i.status?.length ? i.status : undefined, limit: i.limit ?? 10 });
      return ok({ opportunities: rows.slice(0, i.limit ?? 10) }, `${rows.length} opportunities`);
    }
    case "get_alerts": {
      const i = input as z.infer<typeof intelInputs.get_alerts>;
      const since = new Date(deps.now().getTime() - (i.hours ?? 48) * 3_600_000);
      const rows = (await deps.alerts({ since, kind: i.kind, limit: i.limit ?? 10 })).slice(0, i.limit ?? 10);
      return ok({ alerts: rows.map(alertRow) }, `${rows.length} alerts`);
    }
    case "get_intel_brief": {
      const i = input as z.infer<typeof intelInputs.get_intel_brief>;
      const b = await deps.latestBrief(i.surface);
      if (!b) return ok({ brief: null }, "no brief yet");
      const brief = {
        createdAt: b.createdAt,
        surface: b.surface,
        since: b.since,
        silent: b.silent,
        lines: b.lines.slice(0, 10),
        items: b.items.slice(0, 10).map((x) => ({ asset: x.asset, metric: x.metric, held: x.held, from: x.from, to: x.to, delta: x.delta, deltaUnit: x.deltaUnit, z: x.z, materiality: x.materiality })),
        alerts: b.alerts.slice(0, 5).map(alertRow),
        catalysts: b.catalysts.slice(0, 8).map((c) => ({ title: text(c.title, 200), type: c.type, assets: c.assets.slice(0, 6), scheduledAt: c.scheduledAt, exposed: c.exposed, tag: c.tag })),
      };
      return ok({ brief }, `brief ${b.createdAt}${b.silent ? " (silent)" : ""}`);
    }
    case "get_exposure": {
      const e = await deps.exposure();
      const positions = e.positions.slice(0, 40).map((p) => ({
        asset: p.asset, source: p.source, side: p.side, size: p.size, entryPx: p.entryPx, markPx: p.markPx, stopPx: p.stopPx,
        leverage: p.leverage, venue: p.venue, notionalUsd: p.notionalUsd, unrealizedPnl: p.unrealizedPnl,
      }));
      return ok({ positions, totalNotionalUsd: e.totalNotionalUsd, sources: e.sources, truncated: e.positions.length > positions.length || undefined }, `${e.positions.length} positions`);
    }
    case "get_theses": {
      const i = input as z.infer<typeof intelInputs.get_theses>;
      const rows = (await deps.theses()).slice(0, i.limit ?? 5);
      const theses = rows.map((t) => ({
        id: t.id, text: text(t.text, 600), assets: t.assets, createdAt: t.createdAt, checkedAt: t.checkedAt,
        claims: t.claims.slice(0, 8).map((c) => ({ kind: c.kind, text: text(c.text, 300), status: c.status })),
        invalidation: t.invalidation.slice(0, 6).map((x) => ({ text: text(x.text, 300), status: x.status ?? "unknown" })),
      }));
      return ok({ theses }, `${theses.length} theses`);
    }
  }
}
