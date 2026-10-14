import type { Cluster, IntelEvent, SourceHealth } from "../../../shared/intel.js";
import { calendarEvents } from "../calendar.js";
import { clusterItems, entityMerges, extractCluster, CLUSTER_WINDOW_MS } from "../cluster.js";
import { LLM_DEADLINE_MS } from "../llm.js";
import type { NewEvent } from "../store.js";
import { message, recordRun, type AdapterResult, type IngestDeps } from "./common.js";
import { fetchGovernance } from "./governance.js";
import { fetchRss } from "./rss.js";
import { fetchTelegram } from "./telegram.js";
import { fetchWebsearch } from "./websearch.js";
import { fetchX } from "./x.js";

export type { AdapterResult, IngestDeps, RunRecorder } from "./common.js";
export { recordRun } from "./common.js";

// Ingest cycle (SPEC.md § Intel I0.9, I0.10): every source → upsert events →
// cluster the new ones → extract once per new cluster (cheap tier, cached by
// cluster id) → merge clusters on entity overlap. Returns the clusters that
// are ready for the mapper (extracted, not merged away, not yet mapped).
//
// Re-ingest: a headline already stored is not upserted again, so the type,
// entities and assets its cluster's extraction filled in are not reset to
// "other". Governance and calendar events are structured at the source and
// upsert every run (vote state and dates can change); calendar events are
// catalysts only and are never clustered. A cluster whose extraction failed
// or was cut off by the budget is retried on the next run while it is recent.
// A cluster merged into another keeps its row (the store has no delete):
// its events move, and it is stamped mapped_at with a "merged into" label so
// the mapper never picks it up.

const UNSTRUCTURED = new Set<NewEvent["origin"]>(["rss", "websearch", "x", "telegram"]);
const KNOWN_KEYS_LOOKBACK_MS = 7 * 86_400_000;
const RECENT_LIMIT = 5000;
const STOP_ERRORS = /^(?:llm not configured|LLM cap reached)/;

export interface IngestSummary {
  sources: SourceHealth[];
  newClusters: string[];
  /** Events written this run. */
  upserted: number;
  extracted: number;
  extractFailed: number;
  /** Recent clusters still without an extraction (budget or failure); retried next run. */
  pending: number;
}

type Adapter = [source: string, run: (deps: IngestDeps) => Promise<AdapterResult>];

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
const earlier = (a: string, b: string) => (Date.parse(a) <= Date.parse(b) ? a : b);

export async function runIngestSources(deps: IngestDeps, opts: { budgetMs: number; signal?: AbortSignal }): Promise<IngestSummary> {
  const t0 = Date.now();
  const left = () => opts.budgetMs - (Date.now() - t0);
  const signal = opts.signal ?? deps.signal;
  const d: IngestDeps = { ...deps, signal };
  const now = deps.now();
  const { store } = deps;

  const adapters: Adapter[] = [
    ["rss", fetchRss],
    ["governance", fetchGovernance],
    ["websearch", fetchWebsearch],
    ["x", fetchX],
    ["telegram", fetchTelegram],
    ["calendar", async () => ({ source: "calendar", ok: true, items: calendarEvents(now, new Date(now.getTime() - 7 * 86_400_000)) })],
  ];
  const results = await Promise.all(
    adapters.map(async ([source, run]): Promise<AdapterResult> => {
      const startedAt = new Date();
      let r: AdapterResult;
      try {
        r = await run(d);
      } catch (e) {
        r = { source, ok: false, items: [], error: message(e).slice(0, 500) };
      }
      await recordRun(r, startedAt, deps.record);
      return r;
    }),
  );
  const sources: SourceHealth[] = results.map((r) => ({ source: r.source, ok: r.ok, ...(r.error ? { error: r.error } : {}) }));

  // ---- upsert
  const recent = await store.listEvents({ since: new Date(now.getTime() - KNOWN_KEYS_LOOKBACK_MS), limit: RECENT_LIMIT });
  const known = new Set(recent.map((e) => e.key));
  const items = results.flatMap((r) => r.items).filter((e) => !(UNSTRUCTURED.has(e.origin) && known.has(e.key)));
  const written = items.length ? await store.upsertEvents(items) : [];

  // ---- cluster
  const clusterable = (e: IntelEvent) => e.origin !== "calendar";
  const fresh = written.filter((e) => !e.clusterId && clusterable(e));
  const anchorSince = now.getTime() - 2 * CLUSTER_WINDOW_MS;
  const anchors = recent.filter((e) => e.clusterId && clusterable(e) && Date.parse(e.firstSeen) >= anchorSince);
  const byId = new Map(fresh.map((e) => [e.id, e]));
  const groups = clusterItems([...anchors, ...fresh].map((e) => ({ id: e.id, key: e.key, title: e.title, ts: e.firstSeen, clusterId: e.clusterId })));
  for (const g of groups) {
    const cur = g.existing ? await store.getCluster(g.id) : null;
    // Upsert before assigning: intel_events.cluster_id references intel_clusters.
    await store.upsertCluster(
      cur
        ? { ...cur, firstSeen: earlier(cur.firstSeen, g.firstSeen), lastSeen: later(cur.lastSeen, g.lastSeen) }
        : { id: g.id, label: byId.get(g.newItemIds[0]!)?.title.slice(0, 200) ?? null, entities: [], extraction: null, firstSeen: g.firstSeen, lastSeen: g.lastSeen, mappedAt: null },
    );
    await store.setEventCluster(g.newItemIds, g.id);
  }

  // ---- extract (new clusters, and recent ones a previous run could not finish)
  const windowStart = new Date(now.getTime() - CLUSTER_WINDOW_MS);
  const todo = (await store.listClusters(windowStart)).filter((c) => !c.extraction && !c.mappedAt);
  const extracted: string[] = [];
  let extractFailed = 0;
  for (const c of todo) {
    if (left() <= 0 || signal?.aborted) break;
    const events = await store.eventsByCluster(c.id);
    if (!events.length) continue;
    const res = await extractCluster({ llm: deps.llm, signal, deadlineMs: Math.max(1, Math.min(LLM_DEADLINE_MS, left())) }, { id: c.id, events });
    if (!res.ok) {
      extractFailed++;
      console.warn(`[intel] extraction failed for cluster ${c.id}: ${res.error}`);
      if (STOP_ERRORS.test(res.error)) break;
      continue;
    }
    const x = res.value;
    await store.upsertCluster({ ...c, extraction: x, entities: [...new Set([...x.entities, ...x.assets])] });
    const enriched = events
      .filter((e) => UNSTRUCTURED.has(e.origin))
      .map(({ id: _id, ...e }) => ({
        ...e,
        type: x.type,
        entities: x.entities,
        assets: x.assets,
        magnitude: x.magnitude,
        summary: e.summary ?? x.summary,
        scheduledAt: e.scheduledAt ?? x.scheduledAt,
        catalyst: e.catalyst ?? x.catalyst,
      }));
    if (enriched.length) await store.upsertEvents(enriched);
    extracted.push(c.id);
  }

  // ---- merge on entity overlap (only merges that involve this run's extractions)
  const done = (await store.listClusters(new Date(now.getTime() - 2 * CLUSTER_WINDOW_MS))).filter((c) => c.extraction);
  const clusters = new Map<string, Cluster>(done.map((c) => [c.id, c]));
  const merges = entityMerges(done.map((c) => ({ id: c.id, type: c.extraction!.type, entities: c.entities, firstSeen: c.firstSeen, lastSeen: c.lastSeen, mappedAt: c.mappedAt })));
  const touched = new Set(extracted);
  for (const [loser, winner] of merges) {
    if (!touched.has(loser) && !touched.has(winner)) continue;
    const l = clusters.get(loser)!;
    const w = clusters.get(winner)!;
    const moved = await store.eventsByCluster(loser);
    const merged: Cluster = { ...w, entities: [...new Set([...w.entities, ...l.entities])], firstSeen: earlier(w.firstSeen, l.firstSeen), lastSeen: later(w.lastSeen, l.lastSeen) };
    await store.upsertCluster(merged);
    clusters.set(winner, merged);
    await store.setEventCluster(
      moved.map((e) => e.id),
      winner,
    );
    await store.upsertCluster({ ...l, label: `merged into ${winner}`, mappedAt: now.toISOString() });
  }

  const ready = [...new Set(extracted.map((id) => merges.get(id) ?? id))].filter((id) => !clusters.get(id)?.mappedAt);
  const pending = (await store.listClusters(windowStart)).filter((c) => !c.extraction && !c.mappedAt).length;
  return { sources, newClusters: ready, upserted: written.length, extracted: extracted.length, extractFailed, pending };
}
