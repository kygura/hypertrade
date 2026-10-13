import { z } from "zod";
import { EDGE_TYPE_WEIGHT, EDGE_TYPES, EdgeTypeSchema, EntitySchema, HttpsUrlSchema, type Edge, type GraphPath } from "../../shared/intel.js";
import { SEED_EDGES } from "./graph-seed.js";
import { completeStructured, LLM_DEADLINE_MS, type LlmDeps } from "./llm.js";
import type { IntelStore, NewEdge } from "./store.js";

// Exposure graph (SPEC.md § Intel I0.8): the pure walk, the seed upsert and
// the daily LLM refresh.
//
// Walk semantics. Edges are stored directed ("src is exposed to dst through
// type"), but the walk is undirected: a shock travels both ways along an
// exposure. An exploit on Jito reaches a SOL holder through jitoSOL (Jito ←
// jitoSOL → SOL), and a SOL crash reaches a jitoSOL holder the same way. Node
// names match case-insensitively ("jito" = "Jito"); paths report the names as
// stored on the edges, with `from`/`to` as the caller passed them. A start
// entity that is itself a target is a direct hit, not a path: the mapper
// handles it (hops 0, weight 1) and walk leaves it out.

const SAME_DAY = (d: Date) => d.toISOString().slice(0, 10);
const norm = (s: string) => s.trim().toLowerCase();

type Step = { node: string; edge: Edge };

/**
 * Best path (≤ maxHops) from any of `fromEntities` to each reachable target.
 * weight = Π EDGE_TYPE_WEIGHT[type] × 0.5^(hops−1). Ties: fewer hops, then the
 * lexically smaller rendering, so the result is deterministic.
 */
export function walk(edges: Edge[], fromEntities: string[], targets: string[], maxHops: 1 | 2 = 2): GraphPath[] {
  const adj = new Map<string, Step[]>();
  const link = (a: string, b: string, edge: Edge) => {
    const list = adj.get(norm(a)) ?? [];
    list.push({ node: b, edge });
    adj.set(norm(a), list);
  };
  for (const e of edges) {
    if (norm(e.src) === norm(e.dst)) continue;
    link(e.src, e.dst, e);
    link(e.dst, e.src, e);
  }

  const targetName = new Map(targets.map((t) => [norm(t), t]));
  const best = new Map<string, GraphPath>();
  const render = (p: GraphPath) => p.edges.map((e) => `${e.from}>${e.to}:${e.type}`).join("|");
  const offer = (p: GraphPath) => {
    const key = norm(p.to);
    const cur = best.get(key);
    if (!cur || p.weight > cur.weight + 1e-12 || (Math.abs(p.weight - cur.weight) <= 1e-12 && (p.hops < cur.hops || (p.hops === cur.hops && render(p) < render(cur))))) {
      best.set(key, p);
    }
  };
  const step = (s: Step) => ({ from: s.edge.src === s.node ? s.edge.dst : s.edge.src, to: s.node, type: s.edge.type });

  for (const from of new Set(fromEntities.map((f) => f.trim()).filter(Boolean))) {
    const start = norm(from);
    for (const s1 of adj.get(start) ?? []) {
      const n1 = norm(s1.node);
      const e1 = step(s1);
      const w1 = EDGE_TYPE_WEIGHT[s1.edge.type];
      const t1 = targetName.get(n1);
      if (t1 !== undefined && n1 !== start) offer({ from, to: t1, edges: [e1], hops: 1, weight: w1 });
      if (maxHops < 2) continue;
      for (const s2 of adj.get(n1) ?? []) {
        const n2 = norm(s2.node);
        if (n2 === start || n2 === n1) continue;
        const t2 = targetName.get(n2);
        if (t2 === undefined) continue;
        offer({ from, to: t2, edges: [e1, step(s2)], hops: 2, weight: w1 * EDGE_TYPE_WEIGHT[s2.edge.type] * 0.5 });
      }
    }
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight || a.to.localeCompare(b.to));
}

/** Seed edges as store rows. */
export function seedEdges(): NewEdge[] {
  return SEED_EDGES.map((e) => ({ src: e.src, dst: e.dst, type: e.type, weight: EDGE_TYPE_WEIGHT[e.type], source: e.source, lastVerified: null, origin: "seed" }));
}

/** Idempotent: upsert keys on (src, dst, type), and user edges are never replaced by seeds. */
export function ensureSeedEdges(store: Pick<IntelStore, "upsertEdges">): Promise<number> {
  return store.upsertEdges(seedEdges());
}

// ---------------------------------------------------------------- refresh

export const GRAPH_PROMPT_VERSION = "graph-v1";
const MAX_PROPOSED = 15;

/** Lenient on purpose: bad items are dropped and counted, not a reason to fail the call. */
const ProposalSchema = z.object({
  edges: z
    .array(
      z.object({
        src: z.string().max(200),
        dst: z.string().max(200),
        type: EdgeTypeSchema,
        source: z.string().max(2000).nullable().optional(),
      }),
    )
    .max(MAX_PROPOSED * 2),
});

const proposalJsonSchema = {
  type: "object" as const,
  properties: {
    edges: {
      type: "array",
      maxItems: MAX_PROPOSED,
      items: {
        type: "object",
        properties: {
          src: { type: "string", maxLength: 64, description: "The exposed node (coin ticker, protocol, stablecoin, chain or macro series)" },
          dst: { type: "string", maxLength: 64, description: "What src is exposed to" },
          type: { type: "string", enum: [...EDGE_TYPES] },
          source: { type: "string", description: "https URL of a page that documents this relationship" },
        },
        required: ["src", "dst", "type", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["edges"],
  additionalProperties: false,
};

const GRAPH_SYSTEM = `You map exposure relationships between crypto assets, protocols, stablecoins, chains and macro series for a risk tool.
Edge types (src is exposed to dst):
- direct: src is dst's token, or dst issues/operates src.
- settles_on: src runs or settles on chain/asset dst.
- collateral: src is backed by, or used as collateral for, dst.
- depends_on_stable: src depends on stablecoin dst for liquidity or settlement.
- primary_venue: src trades mainly on venue dst.
- bridge: src relies on bridge or chain dst to move funds.
- narrative: src trades with narrative dst (AI, memes, RWA, L2).
- macro_beta: src moves with macro series dst (DXY, NASDAQ).
Use web search. Every edge needs an https source URL that documents it; leave out anything you cannot source. Use Hyperliquid tickers for coins. Do not predict prices.`;

export interface GraphRefreshDeps {
  store: Pick<IntelStore, "upsertEdges" | "edgesFor">;
  llm: LlmDeps;
  /** Held ∪ watched assets. */
  targets(): Promise<string[]>;
  now(): Date;
}

export interface GraphRefreshSummary {
  assets: string[];
  done: string[];
  /** Not reached before the budget ran out or the run was aborted. */
  skipped: string[];
  failed: Array<{ asset: string; error: string }>;
  seeded: number;
  stored: number;
  /** Proposed edges refused: no https source, bad node name, self loop, or not touching the asset. */
  dropped: number;
}

/** Validates proposed edges for `asset`; returns the rows to store and how many were refused. */
export function acceptProposals(asset: string, proposed: z.infer<typeof ProposalSchema>["edges"], now: Date): { edges: NewEdge[]; dropped: number } {
  const edges: NewEdge[] = [];
  for (const p of proposed.slice(0, MAX_PROPOSED)) {
    const src = EntitySchema.safeParse(p.src);
    const dst = EntitySchema.safeParse(p.dst);
    const source = HttpsUrlSchema.safeParse(p.source ?? "");
    if (!src.success || !dst.success || !source.success) continue;
    if (norm(src.data) === norm(dst.data)) continue;
    if (norm(src.data) !== norm(asset) && norm(dst.data) !== norm(asset)) continue;
    edges.push({ src: src.data, dst: dst.data, type: p.type, weight: EDGE_TYPE_WEIGHT[p.type], source: source.data, lastVerified: now.toISOString(), origin: "llm" });
  }
  return { edges, dropped: proposed.length - edges.length };
}

/**
 * Daily refresh: one strong, web-searching call per held ∪ watched asset,
 * sequential, stopping when the budget runs out. Calls are cached per asset
 * per UTC day, so a re-run the same day only spends on assets it has not
 * reached yet.
 */
export async function refreshGraph(deps: GraphRefreshDeps, opts: { budgetMs: number; signal?: AbortSignal }): Promise<GraphRefreshSummary> {
  const t0 = Date.now();
  const left = () => opts.budgetMs - (Date.now() - t0);
  const seeded = await ensureSeedEdges(deps.store);
  const assets = [...new Set((await deps.targets()).map((a) => a.trim()).filter(Boolean))];
  const out: GraphRefreshSummary = { assets, done: [], skipped: [], failed: [], seeded, stored: 0, dropped: 0 };

  for (const [i, asset] of assets.entries()) {
    if (left() <= 0 || opts.signal?.aborted) {
      out.skipped.push(...assets.slice(i));
      break;
    }
    const now = deps.now();
    const known = await deps.store.edgesFor([asset]);
    const knownText = known.length ? known.map((e) => `${e.src} -${e.type}-> ${e.dst}`).join("\n") : "(none)";
    const res = await completeStructured({
      tier: "strong",
      system: GRAPH_SYSTEM,
      user: `Asset: ${asset}\nKnown edges:\n${knownText}\n\nPropose up to ${MAX_PROPOSED} edges that touch ${asset} (as src or dst), including ones already known if you can source them.`,
      schema: ProposalSchema,
      jsonSchema: proposalJsonSchema,
      promptVersion: GRAPH_PROMPT_VERSION,
      cacheKey: `graph:${asset}:${SAME_DAY(now)}`,
      webSearch: true,
      signal: opts.signal,
      deadlineMs: Math.max(1, Math.min(LLM_DEADLINE_MS, left())),
      deps: deps.llm,
    });
    if (!res.ok) {
      out.failed.push({ asset, error: res.error });
      continue;
    }
    const { edges, dropped } = acceptProposals(asset, res.value.edges, now);
    out.dropped += dropped;
    out.stored += edges.length ? await deps.store.upsertEdges(edges) : 0;
    out.done.push(asset);
  }
  return out;
}
