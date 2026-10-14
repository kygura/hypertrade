import { Hono } from "hono";
import {
  AssetQuerySchema,
  AssetSchema,
  FlowsQuerySchema,
  HEATMAP_METRICS,
  HeatmapQuerySchema,
  type AssetDetailResponse,
  type AssetEvent,
  type FlowFlag,
  type HeatmapResponse,
} from "../../../shared/intel.js";
import { COINALYZE_COLLECTOR } from "../../collectors/coinalyze.js";
import { assetFlags, flowOptions, loadAssetFlow } from "../../intel/flowEvents.js";
import { walk } from "../../intel/graph.js";
import { assetExposure, graphEdges, type RoutingContext } from "../../intel/mapper.js";
import { FALLBACK_BASELINE_MS, toCatalyst } from "../../intel/terminal.js";
import { pickWindow, spanResult } from "../../intel/windows.js";
import { failure, invalid } from "./http.js";
import type { TerminalRouteDeps } from "./terminal.js";

// /intel flow endpoints (SPEC.md § Flow F1).
//
// GET /heatmap?window=review|1h|6h|24h → held ∪ watched × fixed metrics: signed z and Δ per cell
//     (review = Δ since the last review, z against non-overlapping Δs of that span; 6 h with no review),
//     live flags (detectors incl. degraded, flips, crossings), flow source status. Row materiality =
//     max(|cell z|, non-degraded flag score) × exposure_weight × stop_proximity.
// GET /asset/:coin?days=7 → snapshots, flow rows, events (flow hits, alerts, catalysts) ascending,
//     catalysts, exposure graph (edges touching the coin + ≤ 2-hop paths to held/watched)
// GET /flows?since → stored detector/flip/crossing hits, newest first

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const CATALYST_AHEAD_MS = 14 * DAY_MS;
const LIST_LIMIT = 500;
const FLOW_SOURCE = COINALYZE_COLLECTOR.slice("intel:".length);

export type FlowRouteDeps = Pick<TerminalRouteDeps, "store" | "exposure" | "watched" | "candles1h" | "ingestHealth" | "now" | "env">;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createFlowRoutes(deps: FlowRouteDeps) {
  const { store } = deps;
  const env = deps.env ?? process.env;

  return new Hono()
    .get("/heatmap", async (c) => {
      const parsed = HeatmapQuerySchema.safeParse({ window: c.req.query("window") });
      if (!parsed.success) return invalid(c, parsed.error, "window");
      const { window } = parsed.data;
      try {
        const now = deps.now();
        const t = now.getTime();
        const [exposure, watched, review, health] = await Promise.all([deps.exposure(), deps.watched(), store.lastReview(), deps.ingestHealth().catch(() => [])]);
        const held = new Set(exposure.positions.map((p) => p.asset));
        const targets = [...new Set([...held, ...watched])];
        const ctx: RoutingContext = { exposure, targets, edges: [], feedback: [] };
        const span = window === "review" ? Math.max(HOUR_MS, t - (review ? Date.parse(review.ts) : t - FALLBACK_BASELINE_MS)) : null;
        const o = flowOptions(env);
        const rows: HeatmapResponse["rows"] = [];
        const cells: HeatmapResponse["cells"] = [];
        const flags: FlowFlag[] = [];
        for (const asset of targets) {
          const flow = await loadAssetFlow(store, asset, now);
          const own = assetFlags(asset, flow, now, o);
          const mine = HEATMAP_METRICS.map((metric) => {
            const r = span != null ? spanResult(metric, flow.series[metric], t, span) : pickWindow(flow.windows, metric, window as Exclude<typeof window, "review">)!;
            return { asset, metric, z: r.z, delta: r.delta };
          });
          const exp = await assetExposure(deps, ctx, asset);
          const peak = Math.max(0, ...mine.map((m) => Math.abs(m.z ?? 0)), ...own.filter((f) => !f.degraded).map((f) => f.score));
          rows.push({ asset, held: held.has(asset), materiality: peak * exp.weight * exp.proximity });
          cells.push(...mine);
          flags.push(...own);
        }
        rows.sort((a, b) => b.materiality - a.materiality);
        const run = health.find((h) => h.source === FLOW_SOURCE);
        const flowStatus = !env.COINALYZE_API_KEY?.trim() ? { ok: false, error: "no_source" } : run ? { ok: run.ok, ...(run.error ? { error: run.error } : {}) } : { ok: true };
        const res: HeatmapResponse = { rows, metrics: [...HEATMAP_METRICS], cells, flags, flow: flowStatus, asOf: now.toISOString() };
        return c.json(res);
      } catch (err) {
        return failure(c, err, "intel:heatmap", "heatmap unavailable");
      }
    })
    .get("/asset/:coin", async (c) => {
      const coin = AssetSchema.safeParse(c.req.param("coin"));
      if (!coin.success) return c.json({ error: "invalid asset", field: "coin" }, 400);
      const q = AssetQuerySchema.safeParse({ days: c.req.query("days") });
      if (!q.success) return invalid(c, q.error, "days");
      const asset = coin.data;
      try {
        const now = deps.now();
        const since = new Date(now.getTime() - q.data.days * DAY_MS);
        const [snapshots, flow, flowEvents, alerts, scheduled, edges, exposure, watched] = await Promise.all([
          store.snapshotRange(asset, since, now),
          store.flowSeries(asset, null, since),
          store.listEvents({ since, type: "data", limit: LIST_LIMIT }),
          store.listAlerts({ since, limit: LIST_LIMIT }),
          store.listCatalysts(since, new Date(now.getTime() + CATALYST_AHEAD_MS)),
          graphEdges(store),
          deps.exposure(),
          deps.watched(),
        ]);
        const targets = [...new Set([...exposure.positions.map((p) => p.asset), ...watched])];
        const mine = scheduled.filter((e) => e.assets.some((a) => same(a, asset)));
        const events: AssetEvent[] = [
          ...flowEvents
            .filter((e) => e.assets.some((a) => same(a, asset)))
            .map((e): AssetEvent => ({ ts: e.firstSeen, kind: "flow", title: e.title, tag: e.tag, ...(e.flag ? { numbers: e.flag.numbers } : {}), ...(e.sources[0]?.url ? { url: e.sources[0].url } : {}) })),
          ...alerts
            .filter((a) => a.kind !== "flow" && same(a.asset, asset))
            .map((a): AssetEvent => {
              const url = a.sources.find((s) => s.url)?.url;
              return { ts: a.createdAt, kind: "alert", title: a.title, tag: a.line.tag, claim: a.line, ...(url ? { url } : {}) };
            }),
          ...mine.map((e): AssetEvent => {
            const url = e.sources.find((s) => s.url)?.url;
            return { ts: e.scheduledAt!, kind: "catalyst", title: e.title, tag: e.tag, ...(url ? { url } : {}) };
          }),
        ].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        const res: AssetDetailResponse = {
          snapshots,
          flow,
          events,
          catalysts: mine.map((e) => toCatalyst(e, new Set(targets))),
          graph: { edges: edges.filter((e) => same(e.src, asset) || same(e.dst, asset)), paths: walk(edges, [asset], targets) },
        };
        return c.json(res);
      } catch (err) {
        return failure(c, err, "intel:asset", "asset detail unavailable");
      }
    })
    .get("/flows", async (c) => {
      const q = FlowsQuerySchema.safeParse({ since: c.req.query("since") });
      if (!q.success) return invalid(c, q.error, "since");
      try {
        const events = await store.listEvents({ since: q.data.since ? new Date(q.data.since) : undefined, type: "data", limit: LIST_LIMIT });
        const res: { flags: FlowFlag[] } = { flags: events.flatMap((e) => (e.flag ? [e.flag] : [])) };
        return c.json(res);
      } catch (err) {
        return failure(c, err, "intel:flows", "flows unavailable");
      }
    });
}
