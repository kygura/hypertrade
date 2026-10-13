import { createHash } from "node:crypto";
import { EVENT_TYPES, EventExtractionSchema, type EventExtraction, type EventType, type IntelEvent } from "../../shared/intel.js";
import { completeStructured, type LlmDeps, type StructuredResult } from "./llm.js";

// Headline clustering (SPEC.md § Intel I0.9). Pure, no embeddings
// (`// ponytail:` no keyless embedding source). Two passes:
//   1. Titles → normalized token shingles (k = 1: the set of content words,
//      since headlines are too short for word n-grams to overlap). Jaccard ≥
//      0.5 between items within 48 h → same cluster (transitively).
//   2. After extraction, clusters of the same event type whose entity sets
//      overlap (|A∩B| / min(|A|,|B|) ≥ 0.5) within 48 h merge. Type "other" never
//      merges: it is the bucket for everything unclassified.
// Cluster ids are deterministic UUIDs (intel_clusters.id is a uuid column):
// an item that joins an existing cluster keeps that id; a new group takes a
// hash of its earliest item's key, so re-running on the same input names the
// same cluster and the extraction cache (cacheKey = cluster id) hits.

export const JACCARD_MIN = 0.5;
export const ENTITY_OVERLAP_MIN = 0.5;
export const CLUSTER_WINDOW_MS = 48 * 3600_000;

const STOPWORDS = new Set(
  "a an the of to in on for and or is are was were be been as at by with from into after amid over under its it this that these those has have had says said say report reports reported breaking new news update just will could may might than then via about vs".split(" "),
);

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\$(\d)/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function shingles(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(" ")
      .filter((t) => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Deterministic UUID-shaped id from a seed string. */
export function clusterIdFor(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ClusterItem {
  id: string;
  key: string;
  title: string;
  /** firstSeen, ISO. */
  ts: string;
  clusterId: string | null;
}

export interface ClusterGroup {
  id: string;
  /** True when the id belongs to a cluster an earlier run created. */
  existing: boolean;
  /** Unclustered items to assign to `id`. Already-clustered items never move. */
  newItemIds: string[];
  firstSeen: string;
  lastSeen: string;
}

function unionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  return { find, union };
}

const byTimeThenKey = <T extends { ts: string; key: string }>(a: T, b: T) => Date.parse(a.ts) - Date.parse(b.ts) || a.key.localeCompare(b.key);

/**
 * Groups for every unclustered item in `items`. Already-clustered items (recent
 * history) only serve as anchors: a new item similar to one joins its cluster;
 * when it resembles several, the earliest anchor's cluster wins.
 */
export function clusterItems(items: ClusterItem[], opts: { threshold?: number; windowMs?: number } = {}): ClusterGroup[] {
  const threshold = opts.threshold ?? JACCARD_MIN;
  const windowMs = opts.windowMs ?? CLUSTER_WINDOW_MS;
  const list = [...new Map(items.map((i) => [i.id, i])).values()].sort(byTimeThenKey);
  const sh = list.map((i) => shingles(i.title));
  const t = list.map((i) => Date.parse(i.ts));
  const uf = unionFind(list.length);

  // Items of one existing cluster stay together.
  const firstOf = new Map<string, number>();
  list.forEach((it, i) => {
    if (!it.clusterId) return;
    const f = firstOf.get(it.clusterId);
    if (f === undefined) firstOf.set(it.clusterId, i);
    else uf.union(f, i);
  });
  // Only pairs with a new item are compared: old items are already grouped.
  list.forEach((it, i) => {
    if (it.clusterId) return;
    for (let j = 0; j < list.length; j++) {
      if (j === i || (!list[j]!.clusterId && j < i)) continue;
      if (Math.abs(t[i]! - t[j]!) > windowMs) continue;
      if (jaccard(sh[i]!, sh[j]!) >= threshold) uf.union(i, j);
    }
  });

  const members = new Map<number, number[]>();
  list.forEach((_, i) => {
    const r = uf.find(i);
    members.set(r, [...(members.get(r) ?? []), i]);
  });
  const groups: ClusterGroup[] = [];
  for (const idx of members.values()) {
    const fresh = idx.filter((i) => !list[i]!.clusterId);
    if (!fresh.length) continue;
    // idx is ascending in time, so the first clustered member is the earliest anchor.
    const anchor = idx.find((i) => list[i]!.clusterId);
    const id = anchor !== undefined ? list[anchor]!.clusterId! : clusterIdFor(list[idx[0]!]!.key);
    groups.push({
      id,
      existing: anchor !== undefined,
      newItemIds: fresh.map((i) => list[i]!.id),
      firstSeen: list[idx[0]!]!.ts,
      lastSeen: list[idx.at(-1)!]!.ts,
    });
  }
  return groups;
}

export interface MergeCandidate {
  id: string;
  type: EventType;
  entities: string[];
  firstSeen: string;
  lastSeen: string;
  /** A cluster the mapper already handled wins its merge set, so the story is not alerted twice. */
  mappedAt?: string | null;
}

/** loser id → winner id. The winner is the earliest already-mapped cluster of each merged set, else the earliest. */
export function entityMerges(clusters: MergeCandidate[], opts: { minOverlap?: number; windowMs?: number } = {}): Map<string, string> {
  const minOverlap = opts.minOverlap ?? ENTITY_OVERLAP_MIN;
  const windowMs = opts.windowMs ?? CLUSTER_WINDOW_MS;
  const list = [...clusters].sort((a, b) => Date.parse(a.firstSeen) - Date.parse(b.firstSeen) || a.id.localeCompare(b.id));
  const ents = list.map((c) => new Set(c.entities.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  const uf = unionFind(list.length);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      if (a.type !== b.type || a.type === "other") continue;
      const gap = Math.max(Date.parse(a.firstSeen), Date.parse(b.firstSeen)) - Math.min(Date.parse(a.lastSeen), Date.parse(b.lastSeen));
      if (gap > windowMs) continue;
      const small = Math.min(ents[i]!.size, ents[j]!.size);
      if (!small) continue;
      let inter = 0;
      for (const e of ents[i]!) if (ents[j]!.has(e)) inter++;
      if (inter / small >= minOverlap) uf.union(i, j);
    }
  }
  const sets = new Map<number, number[]>();
  list.forEach((_, i) => sets.set(uf.find(i), [...(sets.get(uf.find(i)) ?? []), i]));
  const out = new Map<string, string>();
  for (const idx of sets.values()) {
    const winner = idx.find((i) => list[i]!.mappedAt) ?? idx[0]!;
    for (const i of idx) if (i !== winner) out.set(list[i]!.id, list[winner]!.id);
  }
  return out;
}

// ---------------------------------------------------------------- extraction

export const EXTRACT_PROMPT_VERSION = "extract-v1";
const MAX_HEADLINES = 8;

export const eventExtractionJsonSchema = {
  type: "object" as const,
  properties: {
    type: { type: "string", enum: [...EVENT_TYPES] },
    entities: { type: "array", maxItems: 20, items: { type: "string", maxLength: 64 }, description: "Protocols, coins, stablecoins, chains, companies or macro series named or directly implied" },
    assets: { type: "array", maxItems: 20, items: { type: "string", maxLength: 24, pattern: "^([A-Za-z0-9]+:)?[A-Za-z0-9]+$" }, description: "Coin tickers, Hyperliquid naming (BTC, SOL, kPEPE)" },
    magnitude: { type: "string", enum: ["low", "med", "high"], description: "How large the event is for the named entities, not a price call" },
    summary: { type: "string", maxLength: 600 },
    scheduledAt: { type: ["string", "null"], description: "ISO 8601 with offset when the item announces a dated future event (unlock, listing, upgrade, vote end), else null" },
    catalyst: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: { size: { type: "string", maxLength: 120 }, directionHypothesis: { type: "string", enum: ["up", "down", "unclear"] } },
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["type", "entities", "assets", "magnitude", "summary", "scheduledAt", "catalyst"],
  additionalProperties: false,
};

const EXTRACT_SYSTEM = `You turn a group of near-duplicate crypto/macro headlines into one structured event for a risk tool.
Classify the event type, list the entities and coin tickers involved, size the magnitude (low/med/high) of the event itself, and summarise what happened in one or two plain sentences using only what the headlines say.
Set scheduledAt only for a dated future event. Never predict prices; catalyst.directionHypothesis is a labelled guess and may be "unclear".`;

export interface ExtractInput {
  id: string;
  events: Array<Pick<IntelEvent, "title" | "summary" | "sources" | "firstSeen">>;
}

/** Cheap-tier extraction, cached per cluster id. */
export function extractCluster(deps: { llm: LlmDeps; signal?: AbortSignal; deadlineMs?: number }, cluster: ExtractInput): Promise<StructuredResult<EventExtraction>> {
  const lines = cluster.events.slice(0, MAX_HEADLINES).map((e) => {
    const src = e.sources.map((s) => s.label).join(", ") || "unknown source";
    const summary = e.summary ? `\n  ${e.summary.slice(0, 300)}` : "";
    return `- [${e.firstSeen}] ${e.title.slice(0, 300)} (${src})${summary}`;
  });
  return completeStructured({
    tier: "cheap",
    system: EXTRACT_SYSTEM,
    user: `Headlines:\n${lines.join("\n")}`,
    schema: EventExtractionSchema,
    jsonSchema: eventExtractionJsonSchema,
    promptVersion: EXTRACT_PROMPT_VERSION,
    cacheKey: `cluster:${cluster.id}`,
    signal: deps.signal,
    deadlineMs: deps.deadlineMs,
    deps: deps.llm,
  });
}
