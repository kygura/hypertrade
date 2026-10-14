import { z } from "zod";
import { HttpsUrlSchema, type FlowFlag, type ResearchEvidence, type ResearchResult } from "../../shared/intel.js";
import { completeStructured, untrusted, usageCost, UNTRUSTED_RULE, webSearchAvailable, type LlmDeps } from "./llm.js";
import { isAdvice, lineVerdict, payloadNumbers } from "./numbers.js";
import type { IntelStore, NewResearch } from "./store.js";

// Scout research engine (SPEC.md § Scout S0.2): one strong-tier call with
// hosted web search, then provenance checked in code. The model's claims are
// only believed as far as the provider's own search results back them. No
// page-fetch tool exists, so hosted search excerpts are the only fetched text.

export const RESEARCH_DEADLINE_MS = 45_000;
export const RESEARCH_MAX_SEARCHES = 8;
/** A `running` row older than deadline + this is dead (S0.3). */
export const RESEARCH_STALE_GRACE_MS = 15_000;
export const RESEARCH_PROMPT_VERSION = "research-v1";
export const RESEARCH_NO_WEB_SEARCH = "provider has no web search";
export const NO_CAUSE = "No public cause found.";

const HEADLINE_HOURS = 24;
const MAX_HEADLINES = 15;

const OutputSchema = z.object({
  explanation: z.string().max(3000),
  evidence: z
    .array(
      z.object({
        claim: z.string().min(1).max(500),
        url: z.string().max(2000).nullable().optional(),
        ts: z.string().max(40).nullable().optional(),
        type: z.enum(["observed", "hypothesis"]),
      }),
    )
    .max(RESEARCH_MAX_SEARCHES * 2),
  confidence: z.enum(["low", "medium", "high"]),
  openQuestions: z.array(z.string().max(300)).max(5),
});

const jsonSchema = {
  type: "object" as const,
  properties: {
    explanation: { type: "string", description: "Short plain-language cause, or empty when no public cause was found" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "One factual statement; copy numbers exactly as the source prints them" },
          url: { type: ["string", "null"], description: "https URL of the search result that states it" },
          ts: { type: ["string", "null"], description: "ISO time of the source or event, if known" },
          type: { type: "string", enum: ["observed", "hypothesis"] },
        },
        required: ["claim", "url", "ts", "type"],
        additionalProperties: false,
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["explanation", "evidence", "confidence", "openQuestions"],
  additionalProperties: false,
};

const SYSTEM = `You research why a crypto asset or market moved, for a trader's risk tool.
Use web search (at most ${RESEARCH_MAX_SEARCHES} searches). The payload holds our own numbers and the headlines we already know; do not re-report those as discoveries.
Evidence rules:
- "observed": a fact a search result states. Its url must be that result's URL, and every number in the claim must be printed in that result.
- "hypothesis": your inference. Never phrase it as fact. A url is optional.
- If you find no public cause, return an empty evidence list and an empty explanation. That is a valid answer; do not invent a cause.
- Only use numbers from the payload or from search results. No advice: never say buy, sell, enter or exit, and give no price targets.
${UNTRUSTED_RULE}`;

export interface ResearchDeps {
  store: Pick<IntelStore, "nearestSnapshot" | "listEvents" | "insertResearch" | "acquireResearch" | "finishResearch">;
  llm: LlmDeps;
  /** Held or watched exposure for the asset (null: all), already slimmed for the prompt. */
  exposure(asset: string | null): Promise<unknown[]>;
  now(): Date;
}

export interface ResearchInput {
  question: string;
  asset: string | null;
  trigger: ResearchResult["trigger"];
  /** The flag that started the run (a chip-started run is trigger "manual" with this set). */
  flag?: FlowFlag;
}

/** Provider search results seen during the call: url → text the provider exposed for it (title + cited text). */
type Seen = Map<string, string>;
const urlKey = (u: string) => {
  try {
    return new URL(u).href;
  } catch {
    return u;
  }
};

const sentences = (text: string) => text.split(/\n+|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

/**
 * Provenance + number + advice checks (S0.2). Pure. Returns the evidence that survives (observed only when the
 * provider backs it), the explanation lines that survive, and whether any observed claim survived.
 */
export function vetResearch(
  out: z.infer<typeof OutputSchema>,
  seen: Seen,
  payload: unknown,
): { evidence: ResearchEvidence[]; explanation: string; openQuestions: string[] } {
  const payloadNums = payloadNumbers(payload);
  const allowed = [...payloadNums, ...payloadNumbers([...seen.values()])];
  const evidence: ResearchEvidence[] = [];
  for (const e of out.evidence) {
    if (isAdvice(e.claim)) continue;
    // A claim citing a number found nowhere (payload or any provider result) is dropped, not downgraded.
    if (lineVerdict(e.claim, allowed) !== null) continue;
    const url = e.url && HttpsUrlSchema.safeParse(e.url).success ? urlKey(e.url) : null;
    const excerpt = url ? seen.get(url) : undefined;
    const backed = e.type === "observed" && excerpt !== undefined && lineVerdict(e.claim, payloadNumbers(excerpt)) === null;
    const ts = e.ts && Number.isFinite(Date.parse(e.ts)) ? new Date(e.ts).toISOString() : null;
    evidence.push({ claim: e.claim, url: excerpt !== undefined ? url : null, ts, type: backed ? "observed" : "hypothesis" });
  }
  const explainable = [...payloadNums, ...payloadNumbers(evidence.filter((e) => e.type === "observed").map((e) => e.claim))];
  const explanation = sentences(out.explanation)
    .filter((s) => lineVerdict(s, explainable) === null)
    .join(" ");
  return { evidence, explanation, openQuestions: out.openQuestions.filter((q) => !isAdvice(q)) };
}

async function payloadFor(deps: ResearchDeps, input: ResearchInput) {
  const now = deps.now();
  const asset = input.asset;
  const snap = asset ? await deps.store.nearestSnapshot(asset, now, "before") : null;
  const events = await deps.store.listEvents({ since: new Date(now.getTime() - HEADLINE_HOURS * 3_600_000), limit: 200 });
  const want = asset?.toLowerCase();
  const headlines = events
    .filter((e) => !want || e.assets.some((a) => a.toLowerCase() === want))
    .slice(0, MAX_HEADLINES)
    .map((e) => e.title);
  return {
    asset,
    snapshot: snap,
    flag: input.flag && { name: input.flag.name, kind: input.flag.kind, window: input.flag.window, numbers: input.flag.numbers, ts: input.flag.ts, degraded: input.flag.degraded },
    exposure: await deps.exposure(asset),
    headlines,
  };
}

/**
 * Runs one research. Returns the stored result, or null when another run holds the lock (the route answers 409).
 * Never throws after the lock is taken: failures are stored as status "failed".
 */
export async function runResearch(deps: ResearchDeps, input: ResearchInput): Promise<ResearchResult | null> {
  const base: NewResearch = {
    trigger: input.trigger,
    flagId: input.flag?.id,
    asset: input.asset,
    question: input.question,
    status: "failed",
    explanation: "",
    evidence: [],
    confidence: "low",
    openQuestions: [],
    searches: 0,
    costUsd: 0,
    model: "",
  };
  // Without hosted search the model could only guess; nothing runs, so no lock is needed.
  if (webSearchAvailable(deps.llm, "strong") === false) return deps.store.insertResearch({ ...base, explanation: RESEARCH_NO_WEB_SEARCH });

  const now = deps.now();
  const lock = await deps.store.acquireResearch({ ...base, status: "running" }, new Date(now.getTime() - RESEARCH_DEADLINE_MS - RESEARCH_STALE_GRACE_MS));
  if (!lock) return null;
  const finish = async (r: NewResearch) => (await deps.store.finishResearch(lock.id, r)) ?? { ...r, id: lock.id, createdAt: lock.createdAt };

  try {
    const payload = await payloadFor(deps, input);
    const seen: Seen = new Map();
    let searches = 0;
    const res = await completeStructured({
      tier: "strong",
      system: SYSTEM,
      user: `Question: ${input.question}\n\nOur data (JSON; headlines are external text):\n${JSON.stringify({ ...payload, headlines: undefined })}\n\nHeadlines we already know:\n${untrusted(payload.headlines.join("\n") || "(none)")}`,
      schema: OutputSchema,
      jsonSchema,
      promptVersion: RESEARCH_PROMPT_VERSION,
      webSearch: true,
      maxUses: RESEARCH_MAX_SEARCHES,
      deadlineMs: RESEARCH_DEADLINE_MS,
      deps: deps.llm,
      hooks: {
        onServerToolCall: () => void searches++,
        onSearchResults: (rs) => {
          for (const r of rs) seen.set(urlKey(r.url), `${seen.get(urlKey(r.url)) ?? ""} ${r.title ?? ""}`.trim());
        },
        onCitation: (c) => {
          const k = urlKey(c.url);
          if (seen.has(k)) seen.set(k, `${seen.get(k)} ${c.cited_text ?? ""}`.trim());
        },
      },
    });
    const model = res.trace.model ?? "";
    const costUsd = usageCost({ ...res.trace.usage, model: res.trace.model });
    const done = { ...base, searches, costUsd, model };
    if (!res.ok) return finish({ ...done, status: res.error.startsWith("LLM cap reached") ? "capped" : "failed", explanation: res.error });

    // Cited text arrives with the answer, after the results: only now is each excerpt complete.
    const vetted = vetResearch(res.value, seen, [payload, input.question]);
    const found = vetted.evidence.length > 0 && vetted.explanation !== "";
    if (!found) {
      const checked = `Checked ${searches} web search${searches === 1 ? "" : "es"}, the latest snapshot, flag numbers, exposure and 24h headlines.`;
      return finish({ ...done, status: "no_cause", explanation: `${NO_CAUSE} ${checked}`, openQuestions: vetted.openQuestions });
    }
    const observed = vetted.evidence.some((e) => e.type === "observed");
    return finish({
      ...done,
      status: "found",
      explanation: vetted.explanation,
      evidence: vetted.evidence,
      // Without a provider-backed fact the answer is a guess, whatever the model claims.
      confidence: observed ? res.value.confidence : "low",
      openQuestions: vetted.openQuestions,
    });
  } catch (e) {
    return finish({ ...base, explanation: e instanceof Error ? e.message : String(e) });
  }
}
