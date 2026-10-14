import type { Claim } from "../../shared/claims.js";
import type { Alert, EventSource, FlowFlag, FlowMetric, HeatmapMetric, IntelEvent } from "../../shared/intel.js";
import type { CatalystDeps } from "./catalysts.js";
import { confluenceK, materiality as materialityOf, noteSource, type SignalSource } from "./diff.js";
import { DELEV_OI_PCT, detectFlows } from "./flows.js";
import { assetExposure, deepLink, loadContext, routeFor } from "./mapper.js";
import { feedbackActions, sendIntel } from "./notify.js";
import type { IntelStore } from "./store.js";
import { computeWindows, LOOKBACK, parseThresholds, regimeFlags, seriesFromRows, type Series, type Threshold, type WindowResult } from "./windows.js";

// Flow detector pipeline (SPEC.md § Flow F0.4). Runs as a stage of the ingest
// cron (every 15 min, after collect). Per held ∪ watched asset: series from
// snapshots + flow rows → fixed windows → detectors, flips and crossings.
// A hit that is not degraded becomes, once per (name, asset) until its
// conditions clear (the set firing last run lives in intel_settings):
//   event   intel_events type "data", origin "flow", tag observed, the FlowFlag
//           attached; source = snapshot (HL-only inputs) or coinalyze:<venue>
//   alert   kind "flow", ref = event id, materiality = diff.materiality (score ×
//           exposure_weight × stop_proximity × confluence), routed like the mapper:
//           ≥ INTEL_PUSH_MATERIALITY → Telegram now, else batched into the
//           next brief (which merges batched alerts).
// No INTEL_MIN_Z gate: the detector's own conditions are the gate.

export const FLOW_ACTIVE_SETTING = "flow_active";
export const FLOW_PROVIDER = "coinalyze";
const DAY_MS = 86_400_000;

/** Flow metrics seriesFromRows reads (flow OI, funding and buy volume are not heatmap inputs). */
const SERIES_FLOW_METRICS: FlowMetric[] = ["long_short_ratio", "liq_long_usd", "liq_short_usd", "perp_volume_usd", "spot_volume_usd"];
/** Detectors whose inputs include venue flow data (the rest read HL snapshots only). */
const FLOW_INPUTS: Record<string, HeatmapMetric[]> = {
  deleveraging: ["liq_usd"],
  spot_led: ["spot_volume_usd", "perp_volume_usd"],
  perp_led: ["spot_volume_usd", "perp_volume_usd"],
};

export interface AssetFlow {
  series: Series;
  windows: WindowResult[];
  /** Venues seen per heatmap metric (liq_usd = long + short). */
  venues: Partial<Record<HeatmapMetric, string[]>>;
}

/**
 * Series for one asset over the 24 h window's 90-day lookback.
 * ponytail: full 90 d per asset per call (~9k snapshot + 5 × 9k flow rows); pre-aggregate if the heatmap gets slow.
 */
export async function loadAssetFlow(store: Pick<IntelStore, "snapshotRange" | "flowSeries">, asset: string, now: Date): Promise<AssetFlow> {
  const since = new Date(now.getTime() - LOOKBACK["24h"].days * DAY_MS);
  const [snapshots, ...flow] = await Promise.all([store.snapshotRange(asset, since, now), ...SERIES_FLOW_METRICS.map((m) => store.flowSeries(asset, m, since))]);
  const rows = flow.flat();
  const series = seriesFromRows(snapshots, rows);
  const venues: AssetFlow["venues"] = {};
  for (const r of rows) {
    const m: HeatmapMetric = r.metric === "liq_long_usd" || r.metric === "liq_short_usd" ? "liq_usd" : (r.metric as HeatmapMetric);
    if (!venues[m]?.includes(r.venue)) (venues[m] ??= []).push(r.venue);
  }
  return { series, windows: computeWindows(series, now.getTime()), venues };
}

export interface FlowOptions {
  thresholds: Threshold[];
  delevOiPct: number;
}

/** INTEL_THRESHOLDS (default funding>0.0000625), INTEL_DELEV_OI_PCT (default 8). */
export function flowOptions(env: Record<string, string | undefined> = {}): FlowOptions {
  const pct = Number(env.INTEL_DELEV_OI_PCT);
  return { thresholds: parseThresholds(env.INTEL_THRESHOLDS), delevOiPct: env.INTEL_DELEV_OI_PCT?.trim() && Number.isFinite(pct) ? pct : DELEV_OI_PCT };
}

/** Detectors, flips and crossings for one asset (degraded ones included). */
export function assetFlags(asset: string, f: AssetFlow, now: Date, o: FlowOptions): FlowFlag[] {
  const t = now.getTime();
  return [...detectFlows({ asset, now: t, series: f.series, windows: f.windows, delevOiPct: o.delevOiPct }), ...regimeFlags(asset, f.series, t, o.thresholds)];
}

/** The provider of the data a flag read: HL snapshots, or the flow venue(s). */
export function flagSource(flag: FlowFlag, venues: AssetFlow["venues"]): EventSource {
  const metrics = flag.kind === "crossing" ? [flag.name.split(/[<>]/)[0] as HeatmapMetric] : (FLOW_INPUTS[flag.name] ?? []);
  const used = [...new Set(metrics.flatMap((m) => venues[m] ?? []))].sort();
  return used.length ? { label: `${FLOW_PROVIDER}:${used.join("+")}`, url: `/asset/${flag.asset}` } : { label: "snapshot", url: `/markets/${flag.asset}` };
}

const num = (v: number) => String(Number(v.toPrecision(3)));

/** Code-written line: "Long BTC: crowded long (24h) · funding_z 2.41, oi_z_24h 1.3". */
export function flagText(label: string, f: FlowFlag): string {
  const nums = Object.entries(f.numbers).map(([k, v]) => `${k} ${num(v)}`).join(", ");
  return `${label}: ${f.name.replace(/_/g, " ")} (${f.window})${nums ? ` · ${nums}` : ""}`.slice(0, 600);
}

export type FlowDeps = CatalystDeps & { env?: Record<string, string | undefined> };

export interface FlowRun {
  events: IntelEvent[];
  alerts: Alert[];
  errors: string[];
}

export async function flowAlerts(deps: FlowDeps, now: Date): Promise<FlowRun> {
  const out: FlowRun = { events: [], alerts: [], errors: [] };
  const o = flowOptions(deps.env);
  const ctx = await loadContext(deps);
  const prev = (await deps.store.getSetting<Record<string, string>>(FLOW_ACTIVE_SETTING)) ?? {};
  const active: Record<string, string> = {};
  for (const asset of ctx.targets) {
    let flags: FlowFlag[];
    let flow: AssetFlow;
    try {
      flow = await loadAssetFlow(deps.store, asset, now);
      flags = assetFlags(asset, flow, now, o).filter((f) => !f.degraded);
    } catch (e) {
      // Unknown this run: keep the asset's open episodes so they are not re-alerted next run.
      for (const [k, id] of Object.entries(prev)) if (k.endsWith(`|${asset}`)) active[k] = id;
      out.errors.push(`${asset}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // One per name: the strongest window.
    const best = new Map<string, FlowFlag>();
    for (const f of flags) {
      const cur = best.get(f.name);
      if (!cur || f.score > cur.score) best.set(f.name, f);
    }
    const classOf = (f: FlowFlag): SignalSource => (f.kind === "detector" ? "flow" : "regime");
    // Every class firing now is known before any alert is routed, so siblings get the same k in any order.
    for (const f of best.values()) if (!prev[`${f.name}|${asset}`]) noteSource(ctx.sources, asset, classOf(f));
    for (const f of best.values()) {
      const k = `${f.name}|${asset}`;
      if (prev[k]) {
        active[k] = prev[k];
        continue;
      }
      const exp = await assetExposure(deps, ctx, asset);
      const source = flagSource(f, flow.venues);
      const text = flagText(exp.label, f);
      const [event] = await deps.store.upsertEvents([
        {
          key: `flow:${f.id}`,
          type: "data",
          title: `${f.name} ${asset} (${f.window})`,
          summary: text,
          entities: [asset],
          assets: [asset],
          magnitude: "med",
          sources: [source],
          origin: "flow",
          firstSeen: f.ts,
          scheduledAt: null,
          catalyst: null,
          tag: "observed",
          flag: f,
        },
      ]);
      active[k] = event!.id;
      out.events.push(event!);
      const line: Claim = { tag: "observed", text, source, ts: f.ts };
      const own = classOf(f);
      const materiality = materialityOf({ surprise: f.score, exposure: exp.weight, proximity: exp.proximity }, confluenceK(ctx.sources.get(asset), own));
      const alert = await deps.store.insertAlert({
        kind: "flow",
        ref: event!.id,
        window: null,
        asset,
        title: event!.title,
        eventType: f.name,
        line,
        path: [],
        edgeType: null,
        hops: 0,
        pathWeight: 1,
        sources: [source],
        materiality,
        pricedIn: null,
        route: routeFor(deps.pushMateriality, ctx.feedback, materiality, { eventType: f.name, edgeType: null, hops: 0 }),
      });
      if (!alert) continue;
      out.alerts.push(alert);
      if (alert.route === "push") {
        await sendIntel(deps.notifier, { title: `${exp.label}: ${f.name.replace(/_/g, " ")}`, lines: [line], link: deepLink(deps.appUrl), actions: feedbackActions([alert]) });
      }
    }
  }
  await deps.store.setSetting(FLOW_ACTIVE_SETTING, active);
  return out;
}
