import { SECTORS_HISTORY } from "../../../data/sectors/index.js";
import sectorsLatest from "../../../data/sectors/latest.json" with { type: "json" };
import type { Claim } from "../../shared/claims.js";
import type { Alert, EventSource, NarrativeContrast, NarrativeFlow, NarrativeStage, NarrativeView } from "../../shared/intel.js";
import { SectorsDataSchema } from "../../shared/schemas.js";
import type { SectorsData } from "../../shared/types.js";
import { loadContext, routeFor, type MapperDeps, type RoutingContext } from "./mapper.js";
import { CONTRAST_DEADLINE_MS, CONTRASTS_SETTING, runContrast, VIEWS_SETTING } from "./narrativeContrast.js";
import { loadNarrativeFlows, rankNarratives, strongestMove } from "./narratives.js";
import { feedbackActions, sendIntel } from "./notify.js";
import { AUTO_RESEARCH_MARGIN_MS, utcDayStart } from "./research.js";

// Narrative watch (docs/SPEC.md § Narratives N3.2–N3.4): two code-only stages of
// the ingest cron, both reading the same narrative flows.
//
// Stage alerts (right after the flow detectors). Per narrative the committed HTF
// stage lives in intel_settings (narrative_stages): {stage, since, alertedAt,
// pending, left}. An "unknown" stage changes nothing; the first sight is recorded
// silently; a different known stage must hold STAGE_CONFIRM_RUNS consecutive runs
// and STAGE_CONFIRM_MS (pending) before it is committed; a committed change is
// silent when the narrative alerted within STAGE_COOLDOWN_MS or returns to the
// stage it left less than STAGE_RETURN_MS ago (a threshold never ping-pongs).
// The alert is kind "narrative", asset = narrative id, ref =
// stage:<id>:<to>:<since>, an observed line written by code from the flow facts,
// linking to /sectors. Materiality 1 when the operator has a continuation/fade
// view on the narrative or holds/watches one of its tokens, else 0.2; routed
// like the mapper.
//
// Automatic contrast (the ingest job's last stage, after automatic research).
// Candidates: lean continuation with the LTF flow against the 7d move, or lean
// fade with the flow extending it, flowScore ≥ AUTO_CONTRAST_Z, strongest first.
// At most INTEL_NARRATIVE_AUTO_DAILY runs per UTC day and one per narrative per
// UTC day (narrative_contrast_auto; the manual counter is separate). Views are
// read first: with no continuation/fade lean saved nothing else is loaded. A run
// needs more than its deadline + margin of budget; a capped result stops the
// stage; a no_web_search result does not count. A done result becomes the latest
// contrast and raises one "narrative" alert (ref = contrast:<contrast id>, a
// hypothesis line written by code) only when its favours or agreement differs
// from the previous stored contrast: the same read is not pinged daily. Neither
// stage ever throws.

export const STAGES_SETTING = "narrative_stages";
export const AUTO_SETTING = "narrative_contrast_auto";
export const STAGE_CONFIRM_RUNS = 2;
/** A pending stage must also be at least this old before it is committed. */
export const STAGE_CONFIRM_MS = 2 * 3_600_000;
export const STAGE_COOLDOWN_MS = 12 * 3_600_000;
/** Returning to the stage left less than this long ago is committed silently. */
export const STAGE_RETURN_MS = 24 * 3_600_000;
export const AUTO_CONTRAST_Z = 2.5;
/** Where a narrative line points: the NARRATIVES panel. */
const SOURCE: EventSource = { label: "snapshot", url: "/sectors" };

const intEnv = (v: string | undefined, def: number) => (v?.trim() && Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : def);
/** INTEL_NARRATIVE_AUTO_DAILY (2): automatic contrast runs per UTC day. */
export const narrativeAutoLimit = (env: Record<string, string | undefined>) => intEnv(env.INTEL_NARRATIVE_AUTO_DAILY, 2);

export interface StageState {
  stage: NarrativeStage;
  /** When the committed stage was first seen. */
  since: string;
  alertedAt: string | null;
  /** A different known stage seen `runs` consecutive runs, first at `since`. */
  pending: { stage: NarrativeStage; since: string; runs: number } | null;
  /** The stage the last commit left, and when (absent on rows written before it was tracked). */
  left?: { stage: NarrativeStage; at: string };
}
export type StageStates = Record<string, StageState>;

export interface StageChange {
  id: string;
  from: NarrativeStage;
  to: NarrativeStage;
  since: string;
  /** False inside the cooldown: committed silently. */
  alert: boolean;
}

/** The next stage state per narrative and the changes committed this run (alerted or silent). Narratives no longer in the flows are dropped. Pure. */
export function stageTransitions(prev: StageStates, flows: NarrativeFlow[], nowIso: string): { next: StageStates; changes: StageChange[] } {
  const next: StageStates = {};
  const changes: StageChange[] = [];
  const t = Date.parse(nowIso);
  for (const f of flows) {
    const cur = prev[f.id];
    if (f.stage === "unknown") {
      if (cur) next[f.id] = cur;
      continue;
    }
    if (!cur) {
      next[f.id] = { stage: f.stage, since: nowIso, alertedAt: null, pending: null };
      continue;
    }
    if (f.stage === cur.stage) {
      next[f.id] = { ...cur, pending: null };
      continue;
    }
    const pending = cur.pending?.stage === f.stage ? { ...cur.pending, runs: cur.pending.runs + 1 } : { stage: f.stage, since: nowIso, runs: 1 };
    if (pending.runs < STAGE_CONFIRM_RUNS || t - Date.parse(pending.since) < STAGE_CONFIRM_MS) {
      next[f.id] = { ...cur, pending };
      continue;
    }
    const cooled = cur.alertedAt == null || t - Date.parse(cur.alertedAt) >= STAGE_COOLDOWN_MS;
    const flipBack = cur.left?.stage === f.stage && t - Date.parse(cur.left.at) < STAGE_RETURN_MS;
    const alert = cooled && !flipBack;
    changes.push({ id: f.id, from: cur.stage, to: f.stage, since: pending.since, alert });
    next[f.id] = { stage: f.stage, since: pending.since, alertedAt: alert ? nowIso : cur.alertedAt, pending: null, left: { stage: cur.stage, at: nowIso } };
  }
  return { next, changes };
}

const signed = (x: number | null, unit: string) => (x == null ? "--" : `${x > 0 ? "+" : ""}${x.toFixed(1)}${unit}`);
const plain = (x: number | null) => (x == null ? "--" : x.toFixed(1));

/** Code-written line: "Privacy: emerging → crowded · 7d vs BTC +11.9 pp, OI 7d +18.2%, funding z 2.6" (a missing number reads "--"). */
export function stageLine(f: NarrativeFlow, from: NarrativeStage): string {
  return `${f.label}: ${from} → ${f.stage} · 7d vs BTC ${signed(f.htf.relBtc7d, " pp")}, OI 7d ${signed(f.htf.oiPct7d, "%")}, funding z ${plain(f.htf.fundingZ)}`.slice(0, 600);
}

const AGREEMENT: Record<NarrativeContrast["view"]["agreement"], string> = {
  agrees: "agrees with your view",
  conflicts: "conflicts with your view",
  mixed: "mixed against your view",
  no_view: "no view",
};

/** Code-written line: "Privacy: 6h long build (z 2.9) against the 7d move · your view: continuation · contrast favours fade (medium confidence, conflicts with your view)". */
export function contrastLine(f: NarrativeFlow, view: NarrativeView, c: NarrativeContrast): string {
  const w = strongestMove(f.ltf);
  const flow = w ? `${w.window} ${w.quadrant.replace(/_/g, " ")} (z ${plain(Math.max(Math.abs(w.priceZ ?? 0), Math.abs(w.oiZ ?? 0)))}) ${f.alignment} the 7d move` : "LTF flow";
  return `${f.label}: ${flow} · your view: ${view.lean} · contrast favours ${c.favours} (${c.confidence} confidence, ${AGREEMENT[c.view.agreement]})`.slice(0, 600);
}

/** Views whose flow moves against them (continuation vs against, fade vs with) at flowScore ≥ AUTO_CONTRAST_Z, strongest first. Pure. */
export function contrastCandidates(flows: NarrativeFlow[], views: Record<string, NarrativeView>): NarrativeFlow[] {
  return rankNarratives(
    flows.filter((f) => {
      const lean = views[f.id]?.lean;
      const crossed = (lean === "continuation" && f.alignment === "against") || (lean === "fade" && f.alignment === "with");
      return crossed && f.flowScore != null && f.flowScore >= AUTO_CONTRAST_Z;
    }),
  );
}

export type NarrativeWatchDeps = Pick<MapperDeps, "store" | "llm" | "exposure" | "watched" | "notifier" | "pushMateriality" | "appUrl" | "now"> & {
  env?: Record<string, string | undefined>;
  /** Default to the committed routine files. */
  sectors?: () => SectorsData;
  history?: Array<{ date: string; data: unknown }>;
  /** Default loadNarrativeFlows over `sectors` and `history`. */
  flows?: () => Promise<NarrativeFlow[]>;
};

const sectorsOf = (deps: NarrativeWatchDeps) => (deps.sectors ?? (() => SectorsDataSchema.parse(sectorsLatest)))();
const flowsOf = (deps: NarrativeWatchDeps, sectors: SectorsData) =>
  (deps.flows ?? (() => loadNarrativeFlows({ store: deps.store, now: deps.now, sectors, history: deps.history ?? SECTORS_HISTORY })))();
const viewsOf = async (deps: NarrativeWatchDeps) => (await deps.store.getSetting<Record<string, NarrativeView>>(VIEWS_SETTING)) ?? {};
const contrastsOf = async (deps: NarrativeWatchDeps) => (await deps.store.getSetting<Record<string, NarrativeContrast>>(CONTRASTS_SETTING)) ?? {};
/** Narrative alerts open the NARRATIVES panel. */
const sectorsLink = (appUrl?: string) => (appUrl ? `${appUrl.replace(/\/+$/, "")}/sectors` : undefined);

/** Inserts one narrative alert (null when its ref already exists) and pushes it; a push that reaches no channel falls back to batch. */
async function narrativeAlert(
  deps: NarrativeWatchDeps,
  ctx: RoutingContext,
  a: { ref: string; asset: string; title: string; eventType: string; line: Claim; materiality: number },
): Promise<Alert | null> {
  const alert = await deps.store.insertAlert({
    kind: "narrative",
    ref: a.ref,
    window: null,
    asset: a.asset,
    title: a.title,
    eventType: a.eventType,
    line: a.line,
    path: [],
    edgeType: null,
    hops: 0,
    pathWeight: 1,
    sources: [SOURCE],
    materiality: a.materiality,
    pricedIn: null,
    route: routeFor(deps.pushMateriality, ctx.feedback, a.materiality, { eventType: a.eventType, edgeType: null, hops: 0 }),
  });
  if (alert?.route === "push") {
    const sent = await sendIntel(deps.notifier, { title: a.title, lines: [a.line], link: sectorsLink(deps.appUrl), actions: feedbackActions([alert]) });
    if (!sent.length) {
      // Nothing reached a channel: the next brief carries it.
      await deps.store.setAlertRoute([alert.id], "batch");
      alert.route = "batch";
    }
  }
  return alert;
}

export interface StageAlertRun {
  alerts: Alert[];
  /** Stage changes committed this run (alerted or silent). */
  committed: number;
  errors: string[];
}

/** Stage alerts (N3.2). Never throws: a failed flow load or push is an error in the summary. */
export async function narrativeStageAlerts(deps: NarrativeWatchDeps, now: Date): Promise<StageAlertRun> {
  const out: StageAlertRun = { alerts: [], committed: 0, errors: [] };
  try {
    const [flows, views, ctx] = await Promise.all([flowsOf(deps, sectorsOf(deps)), viewsOf(deps), loadContext(deps)]);
    const prev = (await deps.store.getSetting<StageStates>(STAGES_SETTING)) ?? {};
    const { next, changes } = stageTransitions(prev, flows, now.toISOString());
    out.committed = changes.length;
    const targets = new Set(ctx.targets.map((t) => t.toLowerCase()));
    // Persisted after every alert, with the changes not yet alerted still at their previous state: a crash mid-run
    // must not re-push what already went out (the ref dedupes it anyway) nor silently swallow what did not.
    const waiting = new Set(changes.filter((c) => c.alert).map((c) => c.id));
    const persist = () => deps.store.setSetting(STAGES_SETTING, Object.fromEntries(Object.entries(next).map(([id, s]) => [id, waiting.has(id) ? prev[id]! : s])));
    for (const ch of changes) {
      if (!ch.alert) continue;
      const flow = flows.find((f) => f.id === ch.id)!;
      const lean = views[ch.id]?.lean;
      const focus = lean === "continuation" || lean === "fade" || flow.tokens.some((t) => targets.has(t.toLowerCase()));
      try {
        const text = stageLine(flow, ch.from);
        const alert = await narrativeAlert(deps, ctx, {
          ref: `stage:${ch.id}:${ch.to}:${ch.since}`,
          asset: ch.id,
          title: `${flow.label}: ${ch.from} → ${ch.to}`,
          eventType: `stage_${ch.to}`,
          line: { tag: "observed", text, source: SOURCE, ts: now.toISOString() },
          materiality: focus ? 1 : 0.2,
        });
        if (alert) out.alerts.push(alert);
        waiting.delete(ch.id);
      } catch (e) {
        // Left at its previous state: the next run commits it again and retries.
        out.errors.push(`${ch.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await persist();
    }
    await persist();
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e));
  }
  return out;
}

type AutoState = { day: string; n: number; ids: string[] };

export interface AutoContrastRun {
  /** Runs that reached the provider (capped and no_web_search ones don't count). */
  ran: number;
  statuses: { done: number; failed: number };
  stopped: "cap" | "budget" | "limit" | "no_web_search" | "none";
  errors: string[];
}

/** Automatic contrast (N3.3). Never throws. */
export async function narrativeAutoContrast(deps: NarrativeWatchDeps, o: { left(): number; signal?: AbortSignal }): Promise<AutoContrastRun> {
  const out: AutoContrastRun = { ran: 0, statuses: { done: 0, failed: 0 }, stopped: "none", errors: [] };
  try {
    const now = deps.now();
    const day = utcDayStart(now).toISOString();
    const limit = narrativeAutoLimit(deps.env ?? {});
    const prev = await deps.store.getSetting<AutoState>(AUTO_SETTING);
    const state: AutoState = prev?.day === day ? prev : { day, n: 0, ids: [] };
    if (state.n >= limit) return { ...out, stopped: "limit" };
    // Views first: without a continuation or fade lean there is no candidate, so no flow is loaded.
    const views = await viewsOf(deps);
    if (!Object.values(views).some((v) => v.lean === "continuation" || v.lean === "fade")) return out;
    const sectors = sectorsOf(deps);
    const [flows, ctx] = await Promise.all([flowsOf(deps, sectors), loadContext(deps)]);
    for (const flow of contrastCandidates(flows, views)) {
      if (state.n >= limit) return { ...out, stopped: "limit" };
      if (o.left() <= CONTRAST_DEADLINE_MS + AUTO_RESEARCH_MARGIN_MS) return { ...out, stopped: "budget" };
      if (state.ids.includes(flow.id)) continue;
      const view = views[flow.id]!;
      const rationale = sectors.sectors.find((s) => s.id === flow.id)?.rationale ?? "";
      const res = await runContrast({ store: deps.store, llm: deps.llm, now: deps.now }, { flow, rationale, view, signal: o.signal });
      if (res.status === "no_web_search") return { ...out, stopped: "no_web_search" };
      if (res.status === "capped") return { ...out, stopped: "cap" };
      // Counted before anything else is stored, so a crash cannot buy the same run twice.
      state.n++;
      state.ids.push(flow.id);
      await deps.store.setSetting(AUTO_SETTING, state);
      out.ran++;
      out.statuses[res.status]++;
      if (res.status !== "done") continue;
      const before = (await contrastsOf(deps))[flow.id];
      await deps.store.setSetting(CONTRASTS_SETTING, { ...(await contrastsOf(deps)), [flow.id]: res });
      // The same read as last time is stored, not pinged again.
      if (before && before.favours === res.favours && before.view.agreement === res.view.agreement) continue;
      try {
        await narrativeAlert(deps, ctx, {
          ref: `contrast:${res.id}`,
          asset: flow.id,
          title: `${flow.label}: contrast favours ${res.favours}`,
          eventType: `contrast_${res.favours}`,
          line: { tag: "hypothesis", text: contrastLine(flow, view, res) },
          materiality: 1,
        });
      } catch (e) {
        out.errors.push(`${flow.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e));
  }
  return out;
}
