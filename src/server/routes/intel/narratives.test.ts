import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { NarrativeContrast, NarrativesResponse } from "../../../shared/intel.js";
import type { SectorsData } from "../../../shared/types.js";
import { EmitProvider, llmDeps } from "../../intel/fixtures/emit-provider.js";
import { CONTRASTS_SETTING } from "../../intel/narrativeContrast.js";
import { MemoryIntelStore } from "../../intel/store.js";
import { createNarrativeRoutes } from "./narratives.js";

const NOW = new Date("2026-10-27T12:00:00Z");
const SECTORS: SectorsData = {
  generated_at: "2026-10-27T10:00:00Z",
  sectors: [{ id: "ai", label: "AI", mindshare_score: 0.5, momentum: 0.2, rationale: "TAO and FET bid", tokens: ["TAO", "FET"], sources: [] }],
  rotations: [],
};
const OUT = {
  summary: "No public catalyst found.",
  favours: "fade",
  confidence: "low",
  continuation: { case: "", evidence: [] },
  fade: { case: "", evidence: [] },
  viewWhy: "",
  confirms: [],
  invalidates: [],
  openQuestions: [],
};

function setup(env: Record<string, string> = {}) {
  const store = new MemoryIntelStore(() => NOW);
  const provider = new EmitProvider(() => OUT);
  const app = new Hono().route("/", createNarrativeRoutes({ store, llm: llmDeps(provider, store, () => NOW), now: () => NOW, env, sectors: () => SECTORS, history: [] }));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { store, provider, call };
}

describe("/narratives", () => {
  test("GET lists every basket with no view or contrast yet", async () => {
    const { call } = setup();
    const res = await call("GET", "/narratives");
    expect(res.status).toBe(200);
    const body = res.body as unknown as NarrativesResponse;
    expect(body.sectorsAsOf).toBe("2026-10-27T10:00:00Z");
    expect(body.narratives.map((n) => [n.id, n.stage, n.view, n.contrast])).toEqual([["ai", "unknown", null, null]]);
  });

  test("GET joins the basket's recent headlines, one per cluster, newest first", async () => {
    const { call, store } = setup();
    const ev = (key: string, firstSeen: string, assets: string[], clusterId: string | null = null, url?: string) => ({
      key, type: "other", title: key, summary: null, entities: [], assets, magnitude: "med", sources: [{ label: "rss", url }], origin: "rss", firstSeen, scheduledAt: null, catalyst: null, tag: "observed", clusterId,
    });
    await store.upsertEvents([
      ev("stale", "2026-10-24T11:00:00.000Z", ["TAO"]),
      ev("sol", "2026-10-27T11:00:00.000Z", ["SOL"]),
      ev("first", "2026-10-27T09:00:00.000Z", ["tao"], "c1"),
      ev("later", "2026-10-27T10:00:00.000Z", ["FET", "SOL"], "c1", "https://a/1"),
      ev("alone", "2026-10-27T08:00:00.000Z", ["TAO"]),
    ] as never);
    const get = (await call("GET", "/narratives")).body as unknown as NarrativesResponse;
    expect(get.narratives[0]!.headlines).toEqual([
      { title: "later", firstSeen: "2026-10-27T10:00:00.000Z", url: "https://a/1", assets: ["FET"] },
      { title: "alone", firstSeen: "2026-10-27T08:00:00.000Z", url: null, assets: ["TAO"] },
    ]);
  });

  test("PUT view is validated, stored and joined into GET", async () => {
    const { call } = setup();
    expect((await call("PUT", "/narratives/ai/view", { lean: "maybe" })).status).toBe(400);
    expect((await call("PUT", "/narratives/nope/view", { lean: "fade" })).status).toBe(404);
    const put = await call("PUT", "/narratives/ai/view", { lean: "continuation", note: "  agent infra bid  " });
    expect(put.body).toEqual({ lean: "continuation", note: "agent infra bid", updatedAt: NOW.toISOString() });
    const get = (await call("GET", "/narratives")).body as unknown as NarrativesResponse;
    expect(get.narratives[0]!.view!.lean).toBe("continuation");
  });

  test("POST contrast runs with the stored view, keeps the result, and stops at the daily limit", async () => {
    const { call, store, provider } = setup({ INTEL_NARRATIVE_DAILY: "1" });
    await call("PUT", "/narratives/ai/view", { lean: "continuation", note: "agent infra bid" });
    const res = await call("POST", "/narratives/ai/contrast");
    expect(res.status).toBe(200);
    const c = res.body as unknown as NarrativeContrast;
    expect(c.status).toBe("done");
    // No observed evidence: code overrides the model's "fade".
    expect(c.favours).toBe("unclear");
    expect(c.view).toMatchObject({ lean: "continuation", agreement: "mixed" });
    expect(provider.prompts[0]).toContain("agent infra bid");
    expect((await store.getSetting<Record<string, NarrativeContrast>>(CONTRASTS_SETTING))!.ai!.id).toBe(c.id);
    const get = (await call("GET", "/narratives")).body as unknown as NarrativesResponse;
    expect(get.narratives[0]!.contrast!.id).toBe(c.id);
    expect((await call("POST", "/narratives/ai/contrast")).status).toBe(429);
    expect((await call("POST", "/narratives/nope/contrast")).status).toBe(404);
  });
});
