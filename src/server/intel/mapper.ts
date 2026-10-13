import { z } from "zod";
import type { Claim } from "../../shared/claims.js";
import {
  EDGE_TYPE_WEIGHT,
  type Alert,
  type Edge,
  type EdgeType,
  type EventSource,
  type EventType,
  type ExposurePosition,
  type FeedbackBucket,
  type LlmTrace,
  type Magnitude,
  type PathEdge,
  type PositionsResponse,
} from "../../shared/intel.js";
import type { Notifier } from "../desk/notify.js";
import { claimsJsonSchema, validateClaims } from "./claims.js";
import { atr14, exposureWeight, stopDistance, stopProximity, type Bar } from "./diff.js";
import { seedEdges, walk } from "./graph.js";
import { completeStructured, untrusted, UNTRUSTED_RULE, type LlmDeps } from "./llm.js";
import { sendIntel } from "./notify.js";
import { loadPricedIn, pricedInText } from "./pricedIn.js";
import type { IntelStore } from "./store.js";

// News → position mapper (SPEC.md § Intel I0.11). Code does the routing:
// walk the exposure graph (stored edges over the seed) from the event's
// entities to held ∪ watched assets; an entity that is itself a target is a
// direct hit (hops 0, weight 1). Per exposed asset:
//   line        cheap LLM, one claim-tagged line naming the position side and
//               the mechanism; on any failure a code-written hypothesis
//               "Exposed via <path>" (still tagged, never untagged prose)
//   pricedIn    price/OI since first_seen (pricedIn.ts)
//   materiality magnitude (low .3 / med .6 / high 1) × path weight
//               × exposure_weight × stop_proximity (diff.ts helpers)
//   route       ≥ pushMateriality → push to Telegram now, else batch (next brief)
// Alerts dedupe on (kind, ref, asset); a duplicate is skipped, not re-pushed.
//
// Feedback dampening (operator-requested addition to I0.12, which otherwise
// leaves tuning to the operator): when the (event type, edge type, hops)
// bucket has ≥ 5 votes in the last 30 days and a net score ≤ −60%, a would-be
// push is batched instead. Nothing else changes (thresholds and weights stay
// as configured) and the weekly feedback report still suggests the tuning.
//
// `routeEntities` is the reusable core: docwatch routes contract/doc changes
// through it with kind "docwatch".

export const MAGNITUDE_WEIGHT: Record<Magnitude, number> = { low: 0.3, med: 0.6, high: 1 };
export const MAPPER_PROMPT_VERSION = "mapper-v2";
export const DAMPEN_MIN_VOTES = 5;
export const DAMPEN_NET = -0.6;
const FEEDBACK_LOOKBACK_MS = 30 * 86_400_000;
const ATR_LOOKBACK_MS = 48 * 3_600_000;
const MAX_SOURCES = 5;

export interface MapperDeps {
  store: IntelStore;
  llm: LlmDeps;
  /** loadExposure, injected. */
  exposure(): Promise<PositionsResponse>;
  /** watchedAssets, injected. */
  watched(): Promise<string[]>;
  /** 1h candles, ascending (ATR for stop proximity, priced-in fallback). */
  candles1h(coin: string, from: Date, to: Date): Promise<Array<Bar & { t: number }>>;
  notifier: Notifier;
  /** INTEL_PUSH_MATERIALITY (terminal.loadThresholds). */
  pushMateriality: number;
  /** Base URL for the Telegram deep link (/?review=1). */
  appUrl?: string;
  now(): Date;
}

export interface RouteInput {
  kind: "mapper" | "docwatch";
  /** Dedupe reference: cluster id (mapper) or watch change id (docwatch). */
  ref: string;
  entities: string[];
  eventType: EventType;
  magnitude: Magnitude;
  title: string;
  sources: EventSource[];
  firstSeen: string;
  /** false: skip the LLM and use the code line (default true). */
  explain?: boolean;
}

export interface RouteResult {
  alerts: Alert[];
  alertedAssets: string[];
}

// ---------------------------------------------------------------- shared with catalysts.ts

/** One held/watched asset an event reaches. */
export interface Hit {
  asset: string;
  path: PathEdge[];
  hops: 0 | 1 | 2;
  pathWeight: number;
  /** The path's weakest edge (it dominates the weight); null for a direct hit. Feedback buckets key on it. */
  edgeType: EdgeType | null;
}

export interface RoutingContext {
  exposure: PositionsResponse;
  /** Held ∪ watched. */
  targets: string[];
  edges: Edge[];
  feedback: FeedbackBucket[];
}

const norm = (s: string) => s.trim().toLowerCase();
const edgeKey = (e: { src: string; dst: string; type: string }) => `${e.src}|${e.dst}|${e.type}`;

/** Seed edges overlaid by stored ones (store wins on the same (src, dst, type)). */
export async function graphEdges(store: Pick<IntelStore, "listEdges">): Promise<Edge[]> {
  const merged = new Map<string, Edge>(seedEdges().map((e) => [edgeKey(e), { ...e, id: `seed:${edgeKey(e)}` }]));
  for (const e of await store.listEdges()) merged.set(edgeKey(e), e);
  return [...merged.values()];
}

export async function loadContext(
  deps: Pick<MapperDeps, "store" | "exposure" | "watched" | "now">,
  withFeedback = true,
): Promise<RoutingContext> {
  const [exposure, watched, edges, feedback] = await Promise.all([
    deps.exposure(),
    deps.watched(),
    graphEdges(deps.store),
    withFeedback ? deps.store.feedbackStats(new Date(deps.now().getTime() - FEEDBACK_LOOKBACK_MS)) : Promise.resolve([]),
  ]);
  const targets = [...new Set([...exposure.positions.map((p) => p.asset), ...watched])];
  return { exposure, targets, edges, feedback };
}

/** Direct hits first (hops 0), then the best ≤ 2-hop path to every other reachable target. Pure. */
export function exposureHits(edges: Edge[], entities: string[], targets: string[]): Hit[] {
  const named = new Set(entities.map(norm).filter(Boolean));
  const direct = targets.filter((t) => named.has(norm(t)));
  const hits: Hit[] = direct.map((asset) => ({ asset, path: [], hops: 0, pathWeight: 1, edgeType: null }));
  const rest = targets.filter((t) => !named.has(norm(t)));
  for (const p of walk(edges, entities, rest)) {
    const weakest = p.edges.reduce((w, e) => (EDGE_TYPE_WEIGHT[e.type] < EDGE_TYPE_WEIGHT[w.type] ? e : w));
    hits.push({ asset: p.to, path: p.edges, hops: p.hops as 1 | 2, pathWeight: p.weight, edgeType: weakest.type });
  }
  return hits;
}

export function pathText(h: Hit): string {
  if (!h.path.length) return `${h.asset} named directly`;
  return [h.path[0]!.from, ...h.path.map((e) => `→ ${e.to} (${e.type})`)].join(" ");
}

export interface AssetExposure {
  positions: ExposurePosition[];
  /** "Long SOL" / "Short SOL" / "Watching SOL" (largest position's side). */
  label: string;
  weight: number;
  proximity: number;
}

/** Exposure weight and stop proximity for one asset; candles are read only when a stop is known. */
export async function assetExposure(deps: Pick<MapperDeps, "candles1h" | "now">, ctx: RoutingContext, asset: string): Promise<AssetExposure> {
  const positions = ctx.exposure.positions.filter((p) => p.asset === asset);
  const main = [...positions].sort((a, b) => Math.abs(b.notionalUsd) - Math.abs(a.notionalUsd))[0];
  const label = main ? `${main.side === "long" ? "Long" : "Short"} ${asset}` : `Watching ${asset}`;
  let proximity = 1;
  if (main && positions.some((p) => p.stopPx != null)) {
    const now = deps.now();
    const bars = await deps.candles1h(asset, new Date(now.getTime() - ATR_LOOKBACK_MS), now).catch(() => []);
    proximity = stopProximity(stopDistance(main.markPx, positions), atr14(bars));
  }
  return { positions, label, weight: exposureWeight(positions, ctx.exposure.totalNotionalUsd), proximity };
}

export function deepLink(appUrl?: string): string | undefined {
  return appUrl ? `${appUrl.replace(/\/+$/, "")}/?review=1` : undefined;
}

// ---------------------------------------------------------------- feedback dampening

/** True when the bucket has ≥ DAMPEN_MIN_VOTES votes and (up − down) / votes ≤ DAMPEN_NET. Pure. */
export function dampened(stats: FeedbackBucket[], eventType: string | null, edgeType: EdgeType | null, hops: number): boolean {
  const b = stats.find((s) => s.eventType === eventType && s.edgeType === edgeType && s.hops === hops);
  if (!b) return false;
  const votes = b.up + b.down;
  return votes >= DAMPEN_MIN_VOTES && (b.up - b.down) / votes <= DAMPEN_NET;
}

// ---------------------------------------------------------------- explanation

const ExplainSchema = z.object({ line: z.unknown() });
const explainJsonSchema = {
  type: "object" as const,
  properties: { line: claimsJsonSchema.items },
  required: ["line"],
  additionalProperties: false,
};

const SYSTEM = `You explain, in one line, how a news event touches one trader's position. Code has already found the exposure path; you only put it in words.

Return one object as "line":
- {"tag": "hypothesis", "text"} for the explanation (the usual case).
- {"tag": "observed", "text", "source": {"label", "url"}, "ts"} only when the line restates a fact from one of the event's sources; use that source and the event's firstSeen as ts.

The text starts with the position exactly as given ("Long SOL.", "Short ETH.", "Watching HYPE.") and then names the mechanism along the path, e.g. "Long SOL. The exploit is on Jito, whose jitoSOL is used as SOL collateral, which could cause liquidations." Under 280 characters. Use only the facts given. Never predict direction, never give price targets, never tell the trader to buy, sell, close or size anything.
${UNTRUSTED_RULE} The event (title, sources) is ingested text and comes wrapped that way.`;

const SIDE_WORD = /\b(long|short|watching)\b/i;

async function explain(
  deps: MapperDeps,
  input: RouteInput,
  hit: Hit,
  exp: AssetExposure,
  pricedIn: string | null,
  signal?: AbortSignal,
): Promise<{ line: Claim; trace?: LlmTrace }> {
  const fallback: Claim = { tag: "hypothesis", text: `${exp.label}. Exposed via ${pathText(hit)}.`.slice(0, 600) };
  if (input.explain === false) return { line: fallback };
  const user = JSON.stringify({
    event: untrusted(JSON.stringify({ title: input.title, type: input.eventType, magnitude: input.magnitude, firstSeen: input.firstSeen, sources: input.sources })),
    position: exp.positions.length
      ? {
          label: exp.label,
          notionalUsd: Math.round(exp.positions.reduce((s, p) => s + Math.abs(p.notionalUsd), 0)),
          stopPx: exp.positions.find((p) => p.stopPx != null)?.stopPx ?? null,
        }
      : { label: exp.label, watchlistOnly: true },
    path: pathText(hit),
    pricedIn,
  });
  const r = await completeStructured({
    tier: "cheap",
    system: SYSTEM,
    user,
    schema: ExplainSchema,
    jsonSchema: explainJsonSchema,
    promptVersion: MAPPER_PROMPT_VERSION,
    cacheKey: `${input.ref}:${hit.asset}`,
    signal,
    deps: deps.llm,
  });
  if (!r.ok) return { line: fallback, trace: { ...r.trace, error: r.error } };
  const { claims, dropped } = validateClaims([r.value.line]);
  const trace: LlmTrace = { ...r.trace, cached: r.cached, dropped };
  const claim = claims[0];
  if (!claim) return { line: fallback, trace };
  // The side is the one thing the line must carry; code adds it when the model left it out.
  const text = SIDE_WORD.test(claim.text) ? claim.text : `${exp.label}. ${claim.text}`.slice(0, 600);
  return { line: { ...claim, text }, trace };
}

// ---------------------------------------------------------------- routing

function dedupeSources(sources: EventSource[]): EventSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => {
    const k = s.url ?? s.label;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_SOURCES);
}

async function routeWith(deps: MapperDeps, ctx: RoutingContext, input: RouteInput, signal?: AbortSignal): Promise<RouteResult> {
  const hits = exposureHits(ctx.edges, input.entities, ctx.targets);
  const sources = dedupeSources(input.sources);
  const alerts: Alert[] = [];
  for (const hit of hits) {
    if (signal?.aborted) break;
    // Already alerted (same dedupe key insertAlert enforces): skip before spending candles, priced-in and LLM calls.
    if (await deps.store.alertExists({ kind: input.kind, ref: input.ref, asset: hit.asset, window: null })) continue;
    const exp = await assetExposure(deps, ctx, hit.asset);
    const pricedIn = await loadPricedIn(deps, hit.asset, input.firstSeen);
    const suffix = pricedIn ? pricedInText(pricedIn) : null;
    const materiality = MAGNITUDE_WEIGHT[input.magnitude] * hit.pathWeight * exp.weight * exp.proximity;
    const wantsPush = materiality >= deps.pushMateriality;
    const route = wantsPush && !dampened(ctx.feedback, input.eventType, hit.edgeType, hit.hops) ? "push" : "batch";
    const { line, trace } = await explain(deps, input, hit, exp, suffix, signal);
    const alert = await deps.store.insertAlert({
      kind: input.kind,
      ref: input.ref,
      window: null,
      asset: hit.asset,
      title: input.title.slice(0, 300),
      eventType: input.eventType,
      line,
      path: hit.path,
      edgeType: hit.edgeType,
      hops: hit.hops,
      pathWeight: hit.pathWeight,
      sources,
      materiality,
      pricedIn,
      route,
      ...(trace ? { trace } : {}),
    });
    if (!alert) continue;
    alerts.push(alert);
    if (route === "push") {
      await sendIntel(deps.notifier, { title: `${exp.label}: ${input.title}`.slice(0, 200), lines: suffix ? [line, suffix] : [line], link: deepLink(deps.appUrl) });
    }
  }
  return { alerts, alertedAssets: [...new Set(alerts.map((a) => a.asset))] };
}

/** Walks, explains, scores, stores and routes one event or change. */
export async function routeEntities(deps: MapperDeps, input: RouteInput, opts: { signal?: AbortSignal } = {}): Promise<RouteResult> {
  return routeWith(deps, await loadContext(deps), input, opts.signal);
}

export interface MapSummary {
  /** Clusters routed and stamped mapped_at. */
  mapped: string[];
  /** Not reached (budget/abort); still unmapped, so the next run picks them up. */
  skipped: string[];
  alerts: Alert[];
}

/**
 * Routes each extracted, not-yet-mapped cluster and stamps mapped_at.
 * Clusters merged away (mapped_at set, "merged into …"), already mapped or
 * without an extraction are ignored.
 */
export async function mapClusters(deps: MapperDeps, clusterIds: string[], opts: { signal?: AbortSignal } = {}): Promise<MapSummary> {
  const out: MapSummary = { mapped: [], skipped: [], alerts: [] };
  const ids = [...new Set(clusterIds)];
  let ctx: RoutingContext | null = null;
  for (const [i, id] of ids.entries()) {
    if (opts.signal?.aborted) {
      out.skipped.push(...ids.slice(i));
      break;
    }
    const c = await deps.store.getCluster(id);
    if (!c || c.mappedAt || !c.extraction) continue;
    const x = c.extraction;
    const events = await deps.store.eventsByCluster(id);
    ctx ??= await loadContext(deps);
    const res = await routeWith(
      deps,
      ctx,
      {
        kind: "mapper",
        ref: id,
        entities: [...new Set([...x.entities, ...x.assets])],
        eventType: x.type,
        magnitude: x.magnitude,
        title: c.label ?? events[0]?.title ?? x.summary,
        sources: events.flatMap((e) => e.sources),
        firstSeen: c.firstSeen,
      },
      opts.signal,
    );
    await deps.store.upsertCluster({ ...c, mappedAt: deps.now().toISOString() });
    out.mapped.push(id);
    out.alerts.push(...res.alerts);
  }
  return out;
}
