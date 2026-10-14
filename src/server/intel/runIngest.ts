import { catalystAlerts } from "./catalysts.js";
import { CLUSTER_WINDOW_MS } from "./cluster.js";
import { feedbackReport, REPORT_PERIOD_MS } from "./feedback.js";
import { runIngestSources, type IngestDeps, type IngestSummary } from "./ingest/index.js";
import { loadJournal, weeklyReport, type JournalDeps } from "./journal.js";
import { mapClusters, type MapperDeps } from "./mapper.js";
import { message } from "./ingest/common.js";

// The ingest cron cycle (SPEC.md § Intel I2 `POST /cron/intel/ingest`):
// sources → catalyst alerts (first: they are time-boxed T−24 h / T−1 h
// windows a slow mapper must not starve) → mapper (this run's new clusters
// plus recent ones still unmapped) → the weekly feedback report when a week has passed
// (timestamp in intel_settings) → the weekly journal report on the same cadence,
// only when the journal closed ≥ 1 trade in the period (a quiet week is
// stamped and skipped). Each stage starts only while budget is
// left; a stage that is cut or fails is listed, and the next stage still
// runs if there is time. Never throws.

export const FEEDBACK_SETTING = "feedback_report_at";
export const JOURNAL_SETTING = "journal_report_at";

export type IntelIngestDeps = IngestDeps & MapperDeps & {
  /** Journal wiring for the weekly report; absent → the stage is a no-op. */
  journal?: () => JournalDeps;
};

export type IngestStage = "ingest" | "catalysts" | "mapper" | "feedback" | "journal";

export interface IntelIngestSummary {
  ingest: IngestSummary | null;
  mapped: string[];
  /** Clusters the mapper did not reach this run (picked up next run). */
  unmapped: string[];
  alerts: number;
  pushed: number;
  catalystAlerts: number;
  feedbackReportId: string | null;
  journalReportId: string | null;
  /** Stages not started for lack of budget or an abort. */
  skipped: IngestStage[];
  errors: Array<{ stage: IngestStage; error: string }>;
}

export async function runIntelIngest(deps: IntelIngestDeps, opts: { budgetMs: number; signal?: AbortSignal }): Promise<IntelIngestSummary> {
  const t0 = Date.now();
  const left = () => opts.budgetMs - (Date.now() - t0);
  const deadline = AbortSignal.timeout(Math.max(1, opts.budgetMs));
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  const out: IntelIngestSummary = { ingest: null, mapped: [], unmapped: [], alerts: 0, pushed: 0, catalystAlerts: 0, feedbackReportId: null, journalReportId: null, skipped: [], errors: [] };

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

  await stage("catalysts", async () => {
    const res = await catalystAlerts(deps, deps.now());
    out.catalystAlerts = res.alerts.length;
    out.alerts += res.alerts.length;
    out.pushed += res.alerts.filter((a) => a.route === "push").length;
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

  await stage("feedback", async () => {
    const now = deps.now();
    const last = await deps.store.getSetting<string>(FEEDBACK_SETTING);
    if (last && now.getTime() - Date.parse(last) < REPORT_PERIOD_MS) return;
    const report = await feedbackReport({ store: deps.store, now: deps.now, pushMateriality: deps.pushMateriality });
    await deps.store.setSetting(FEEDBACK_SETTING, now.toISOString());
    out.feedbackReportId = report.id;
  });

  await stage("journal", async () => {
    if (!deps.journal) return;
    const now = deps.now();
    const last = await deps.store.getSetting<string>(JOURNAL_SETTING);
    if (last && now.getTime() - Date.parse(last) < REPORT_PERIOD_MS) return;
    const journal = deps.journal();
    const since = now.getTime() - REPORT_PERIOD_MS;
    const { trades } = await loadJournal(journal, REPORT_PERIOD_MS / 86_400_000);
    if (trades.some((t) => t.closedAt != null && Date.parse(t.closedAt) >= since)) {
      out.journalReportId = (await weeklyReport(journal, REPORT_PERIOD_MS / 86_400_000, signal)).id;
    }
    await deps.store.setSetting(JOURNAL_SETTING, now.toISOString());
  });

  return out;
}
