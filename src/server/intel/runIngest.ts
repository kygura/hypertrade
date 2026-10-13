import { catalystAlerts } from "./catalysts.js";
import { CLUSTER_WINDOW_MS } from "./cluster.js";
import { feedbackReport, REPORT_PERIOD_MS } from "./feedback.js";
import { runIngestSources, type IngestDeps, type IngestSummary } from "./ingest/index.js";
import { mapClusters, type MapperDeps } from "./mapper.js";

// The ingest cron cycle (SPEC.md § Intel I2 `POST /cron/intel/ingest`):
// sources → mapper (this run's new clusters plus recent ones still unmapped)
// → catalyst alerts → the weekly feedback report when a week has passed
// (timestamp in intel_settings). Each stage starts only while budget is
// left; a stage that is cut or fails is listed, and the next stage still
// runs if there is time. Never throws.

export const FEEDBACK_SETTING = "feedback_report_at";

export type IntelIngestDeps = IngestDeps & MapperDeps;

export type IngestStage = "ingest" | "mapper" | "catalysts" | "feedback";

export interface IntelIngestSummary {
  ingest: IngestSummary | null;
  mapped: string[];
  /** Clusters the mapper did not reach this run (picked up next run). */
  unmapped: string[];
  alerts: number;
  pushed: number;
  catalystAlerts: number;
  feedbackReportId: string | null;
  /** Stages not started for lack of budget or an abort. */
  skipped: IngestStage[];
  errors: Array<{ stage: IngestStage; error: string }>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runIntelIngest(deps: IntelIngestDeps, opts: { budgetMs: number; signal?: AbortSignal }): Promise<IntelIngestSummary> {
  const t0 = Date.now();
  const left = () => opts.budgetMs - (Date.now() - t0);
  const deadline = AbortSignal.timeout(Math.max(1, opts.budgetMs));
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const out: IntelIngestSummary = { ingest: null, mapped: [], unmapped: [], alerts: 0, pushed: 0, catalystAlerts: 0, feedbackReportId: null, skipped: [], errors: [] };

  const stage = async (name: IngestStage, run: () => Promise<void>) => {
    if (left() <= 0 || signal.aborted) return void out.skipped.push(name);
    try {
      await run();
    } catch (e) {
      out.errors.push({ stage: name, error: message(e).slice(0, 500) });
    }
  };

  await stage("ingest", async () => {
    out.ingest = await runIngestSources(deps, { budgetMs: left(), signal });
  });

  await stage("mapper", async () => {
    const now = deps.now();
    const pending = (await deps.store.listClusters(new Date(now.getTime() - CLUSTER_WINDOW_MS))).filter((c) => c.extraction && !c.mappedAt).map((c) => c.id);
    const res = await mapClusters(deps, [...(out.ingest?.newClusters ?? []), ...pending], { signal });
    out.mapped = res.mapped;
    out.unmapped = res.skipped;
    out.alerts += res.alerts.length;
    out.pushed += res.alerts.filter((a) => a.route === "push").length;
  });

  await stage("catalysts", async () => {
    const res = await catalystAlerts(deps, deps.now());
    out.catalystAlerts = res.alerts.length;
    out.alerts += res.alerts.length;
    out.pushed += res.alerts.length;
  });

  await stage("feedback", async () => {
    const now = deps.now();
    const last = await deps.store.getSetting<string>(FEEDBACK_SETTING);
    if (last && now.getTime() - Date.parse(last) < REPORT_PERIOD_MS) return;
    const report = await feedbackReport({ store: deps.store, now: deps.now, pushMateriality: deps.pushMateriality });
    await deps.store.setSetting(FEEDBACK_SETTING, now.toISOString());
    out.feedbackReportId = report.id;
  });

  return out;
}
