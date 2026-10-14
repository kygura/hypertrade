import { Hono } from "hono";
import { EDGE_TYPE_WEIGHT, EdgeKeySchema, GraphQuerySchema, UserEdgeInputSchema, type Edge, type GraphResponse } from "../../../shared/intel.js";
import { walk } from "../../intel/graph.js";
import type { IntelStore, NewEdge } from "../../intel/store.js";
import { body, failure } from "./http.js";

// /intel/graph — the exposure graph (SPEC.md § Intel I0.8, I2).
//
// GET    /graph?asset=SOL   → {asset, edges touching it, best ≤2-hop paths from it to held/watched assets}
// POST   /graph/edges       {src, dst, type, weight?, source} → 201 Edge (the stored user edge; https source required)
// DELETE /graph/edges       {src, dst, type} → {deleted: true}; seed and LLM edges are refused (400)

export interface GraphRouteDeps {
  store: Pick<IntelStore, "listEdges" | "upsertEdges" | "deleteUserEdge">;
  /** Held ∪ watched assets. */
  targets(): Promise<string[]>;
  now?: () => Date;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function createGraphRoutes(deps: GraphRouteDeps) {
  const now = deps.now ?? (() => new Date());
  return new Hono()
    .get("/graph", async (c) => {
      const parsed = GraphQuerySchema.safeParse({ asset: c.req.query("asset") });
      if (!parsed.success) return c.json({ error: "invalid asset", field: "asset" }, 400);
      const { asset } = parsed.data;
      try {
        const [edges, targets] = await Promise.all([deps.store.listEdges(), deps.targets()]);
        const res: GraphResponse = {
          asset,
          edges: edges.filter((e) => same(e.src, asset) || same(e.dst, asset)),
          paths: walk(edges, [asset], targets),
        };
        return c.json(res);
      } catch (err) {
        return failure(c, err, "intel:graph");
      }
    })
    .post("/graph/edges", async (c) => {
      const parsed = UserEdgeInputSchema.safeParse(await body(c));
      if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid edge", field: parsed.error.issues[0]?.path.join(".") }, 400);
      const e = parsed.data;
      if (!e.source) return c.json({ error: "an https source URL is required", field: "source" }, 400);
      try {
        const row: NewEdge = { src: e.src, dst: e.dst, type: e.type, weight: e.weight ?? EDGE_TYPE_WEIGHT[e.type], source: e.source, lastVerified: now().toISOString(), origin: "user" };
        await deps.store.upsertEdges([row]);
        const saved = (await deps.store.listEdges()).find((x: Edge) => x.src === e.src && x.dst === e.dst && x.type === e.type);
        return saved ? c.json(saved, 201) : c.json({ error: "edge not stored" }, 500);
      } catch (err) {
        return failure(c, err, "intel:graph");
      }
    })
    .delete("/graph/edges", async (c) => {
      const parsed = EdgeKeySchema.safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid edge key", field: parsed.error.issues[0]?.path.join(".") }, 400);
      const k = parsed.data;
      try {
        if (await deps.store.deleteUserEdge(k)) return c.json({ deleted: true });
        const existing = (await deps.store.listEdges()).find((x) => x.src === k.src && x.dst === k.dst && x.type === k.type);
        if (existing) return c.json({ error: `${existing.origin} edges cannot be deleted; only user edges`, field: "type" }, 400);
        return c.json({ error: "edge not found" }, 404);
      } catch (err) {
        return failure(c, err, "intel:graph");
      }
    });
}
