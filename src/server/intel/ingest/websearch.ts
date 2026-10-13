import { z } from "zod";
import { AssetSchema, EVENT_TYPES, EventTypeSchema, HttpsUrlSchema } from "../../../shared/intel.js";
import { completeStructured } from "../llm.js";
import type { NewEvent } from "../store.js";
import { fresh, hashKey, headlineEvent, hostLabel, message, pastIso, SKIPPED_DISABLED, SKIPPED_THROTTLED, type AdapterResult, type IngestDeps } from "./common.js";

// LLM web-search sweep (SPEC.md § Intel I0.10, I0.13): strong tier with web
// search, at most once an hour (store setting), only with INTEL_WEBSEARCH=true.
// Returns recent headlines and scheduled catalysts (unlocks, listings and
// delistings, mainnets/upgrades). An item without a usable https URL is a
// `hypothesis`, never an observed fact.

export const WEBSEARCH_PROMPT_VERSION = "websearch-v1";
export const WEBSEARCH_SETTING = "websearch:last_run";
export const WEBSEARCH_MIN_INTERVAL_MS = 3600_000;

const SweepSchema = z.object({
  headlines: z
    .array(
      z.object({
        title: z.string().max(400),
        url: z.string().max(2000).nullable().optional(),
        summary: z.string().max(1000).nullable().optional(),
        publishedAt: z.string().max(60).nullable().optional(),
      }),
    )
    .max(40),
  catalysts: z
    .array(
      z.object({
        title: z.string().max(400),
        type: EventTypeSchema,
        assets: z.array(z.string().max(40)).max(10),
        scheduledAt: z.string().max(60),
        url: z.string().max(2000).nullable().optional(),
        size: z.string().max(200).nullable().optional(),
        directionHypothesis: z.enum(["up", "down", "unclear"]).nullable().optional(),
      }),
    )
    .max(40),
});
export type Sweep = z.infer<typeof SweepSchema>;

const sweepJsonSchema = {
  type: "object" as const,
  properties: {
    headlines: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string", description: "https URL of the article you read" },
          summary: { type: "string" },
          publishedAt: { type: "string", description: "ISO 8601" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
    catalysts: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string", enum: [...EVENT_TYPES] },
          assets: { type: "array", items: { type: "string" }, description: "Hyperliquid tickers" },
          scheduledAt: { type: "string", description: "ISO 8601 date-time of the event" },
          url: { type: "string" },
          size: { type: "string", description: "e.g. '2.1% of supply, $40M'" },
          directionHypothesis: { type: "string", enum: ["up", "down", "unclear"] },
        },
        required: ["title", "type", "assets", "scheduledAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["headlines", "catalysts"],
  additionalProperties: false,
};

const SWEEP_SYSTEM = `You sweep the web for crypto market news for a risk tool. Report facts with the URL you read them at; do not predict prices.
Headlines: material news from the last 24 hours (exploits, depegs, listings/delistings, regulation, outages, governance, large liquidations, macro).
Catalysts: dated events in the next 30 days (token unlocks, exchange listings/delistings, mainnet launches and upgrades). directionHypothesis is a labelled guess and may be "unclear".`;

const url = (raw: string | null | undefined) => {
  const p = HttpsUrlSchema.safeParse(raw ?? "");
  return p.success ? p.data : null;
};

/** Pure: sweep output → events. Catalysts need a parseable scheduledAt; assets that are not tickers are dropped. */
export function sweepEvents(sweep: Sweep, now: Date): NewEvent[] {
  const out: NewEvent[] = [];
  for (const h of sweep.headlines) {
    const title = h.title.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!title) continue;
    const link = url(h.url);
    const firstSeen = pastIso(h.publishedAt, now) ?? now.toISOString();
    if (!fresh(firstSeen, now)) continue;
    out.push(
      headlineEvent({
        key: `websearch:${hashKey(link ?? title.toLowerCase())}`,
        title,
        summary: h.summary?.trim().slice(0, 600),
        url: link,
        label: link ? hostLabel(link, "web search").slice(0, 120) : "LLM web search (no URL)",
        origin: "websearch",
        firstSeen,
      }),
    );
  }
  for (const c of sweep.catalysts) {
    const title = c.title.replace(/\s+/g, " ").trim().slice(0, 300);
    const t = Date.parse(c.scheduledAt);
    if (!title || !Number.isFinite(t)) continue;
    const link = url(c.url);
    const scheduledAt = new Date(t).toISOString();
    const assets = [...new Set(c.assets.map((a) => a.trim().replace(/^\$/, "")).filter((a) => AssetSchema.safeParse(a).success))];
    const size = c.size?.trim().slice(0, 120);
    out.push({
      key: `websearch:cat:${hashKey(`${title.toLowerCase()}|${scheduledAt.slice(0, 10)}`)}`,
      type: c.type,
      title,
      summary: null,
      entities: assets,
      assets,
      magnitude: "med",
      sources: [link ? { label: hostLabel(link, "web search").slice(0, 120), url: link } : { label: "LLM web search (no URL)" }],
      origin: "websearch",
      firstSeen: now.toISOString(),
      scheduledAt,
      catalyst: { ...(size ? { size } : {}), ...(c.directionHypothesis ? { directionHypothesis: c.directionHypothesis } : {}) },
      tag: link ? "observed" : "hypothesis",
    });
  }
  return out;
}

export async function fetchWebsearch(deps: Pick<IngestDeps, "store" | "llm" | "env" | "now" | "targets" | "signal">): Promise<AdapterResult> {
  if (deps.env.INTEL_WEBSEARCH !== "true") return { source: "websearch", ok: true, items: [], error: SKIPPED_DISABLED };
  const now = deps.now();
  try {
    const last = await deps.store.getSetting<string>(WEBSEARCH_SETTING);
    if (last && now.getTime() - Date.parse(last) < WEBSEARCH_MIN_INTERVAL_MS) return { source: "websearch", ok: true, items: [], error: SKIPPED_THROTTLED };
    // Stamped before the call: a sweep that fails still waits an hour, so a broken provider cannot burn the daily cap.
    await deps.store.setSetting(WEBSEARCH_SETTING, now.toISOString());
    const assets = (await deps.targets()).slice(0, 30);
    const res = await completeStructured({
      tier: "strong",
      system: SWEEP_SYSTEM,
      user: `Now: ${now.toISOString()}\nFocus assets: ${assets.join(", ") || "BTC, ETH, SOL, HYPE"} (also report market-wide news).`,
      schema: SweepSchema,
      jsonSchema: sweepJsonSchema,
      promptVersion: WEBSEARCH_PROMPT_VERSION,
      cacheKey: `websearch:${now.toISOString().slice(0, 13)}`,
      webSearch: true,
      signal: deps.signal,
      deps: deps.llm,
    });
    if (!res.ok) return { source: "websearch", ok: false, items: [], error: res.error };
    return { source: "websearch", ok: true, items: sweepEvents(res.value, now) };
  } catch (e) {
    return { source: "websearch", ok: false, items: [], error: message(e).slice(0, 500) };
  }
}
