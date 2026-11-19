import { buildSeed, buildThesis } from "../../shared/regime/build.js";
import { THESIS_SCHEMA, THESIS_SYSTEM, priorForPrompt, thesisUser } from "../../shared/regime/prompt.js";
import { RegimeDraftSchema } from "../../shared/regime/schema.js";
import type { Evidence, HistoryEntry, Link, RegimeThesis } from "../../shared/regime/types.js";
import { UNTRUSTED_RULE, completeStructured, untrusted, type LlmDeps } from "../intel/llm.js";
import { collectAll, type CollectDeps, type CollectResult } from "./collect.js";
import type { RegimeStore } from "./store.js";

// One rewrite of the regime thesis (docs/REGIME.md), start to finish: take the lock, collect, decide whether anything
// is new, ask the strong tier (with hosted web search) for the next version through completeStructured (zod checks
// the draft and fails closed), clean it in code (build.ts: clamps, catalog weights, consensus, URLs limited to what the
// run saw), save it, remember what was read, release the lock. A failed call leaves the previous version standing.

export const REGIME_PROMPT_VERSION = "regime-v1";
/** Web searches per rewrite, retry included. */
export const REGIME_MAX_SEARCHES = 12;
/** A rewrite reads long reports and searches a dozen times: well past the 60 s default. */
export const REGIME_DEADLINE_MS = 6 * 60_000;

export interface RegimeDeps {
  store: RegimeStore;
  llm: LlmDeps;
  env: Record<string, string | undefined>;
  now(): Date;
  /** Hyperliquid contexts for the market snapshot. */
  ctxs?: CollectDeps["ctxs"];
  fetchFn?: CollectDeps["fetchFn"];
  /** Stand-in for tests. */
  collect?: (deps: CollectDeps) => Promise<CollectResult>;
}

export type UpdateResult =
  | { status: "written"; thesis: RegimeThesis; notes: string[] }
  | { status: "skipped" | "locked"; reason: string; notes: string[] }
  | { status: "failed"; error: string; notes: string[] };

/** Data snapshots (no URL) are read fresh every run; reports and notes count as new once. */
export const isReport = (e: Evidence) => e.url != null || e.source === "weekly-tape";

export function collect(deps: RegimeDeps): Promise<CollectResult> {
  return (deps.collect ?? collectAll)({ env: deps.env, now: deps.now().getTime(), fetchFn: deps.fetchFn, ctxs: deps.ctxs });
}

export async function updateRegime(deps: RegimeDeps, opts: { ifNew?: boolean } = {}): Promise<UpdateResult> {
  const now = deps.now();
  if (!(await deps.store.lock(now))) return { status: "locked", reason: "A thesis rewrite is already running.", notes: [] };
  try {
    const { evidence, notes } = await collect(deps);
    const [seen, previous, history] = await Promise.all([deps.store.seen(), deps.store.thesis(), deps.store.history(13)]);
    const fresh = evidence.filter((e) => isReport(e) && !seen.has(e.id));
    if (opts.ifNew && previous && !fresh.length) return { status: "skipped", reason: "No new report or note since the last version.", notes };

    const reports = previous ? fresh : evidence.filter(isReport);
    const snapshots = evidence.filter((e) => !isReport(e));
    const read = [...reports, ...snapshots];
    const iso = now.toISOString();
    const user = thesisUser({
      now: iso,
      previous: priorForPrompt(previous),
      history: history.slice(1, 13).map((h) => ({ version: h.version, created: h.created, phase: h.phase, changelog: h.changelog })),
      evidence: reports.map((e) => ({ source: e.source, kind: e.kind, title: e.title, url: e.url, published: e.published, text: e.text })),
      market: { snapshots: snapshots.map((e) => ({ source: e.source, title: e.title, text: e.text, data: e.data ?? null })), collector_notes: notes },
    });

    // Every URL the provider's search returned, as it returned it: build.ts keeps only cited URLs from this list.
    const searched = new Map<string, Link>();
    const r = await completeStructured({
      tier: "strong",
      system: `${THESIS_SYSTEM}\n\n${UNTRUSTED_RULE}`,
      // The ask stays outside; the payload (previous thesis, reports, snapshots) goes in as data.
      user: `${user.slice(0, user.indexOf("\n\n"))}\n\n${untrusted(user.slice(user.indexOf("\n\n") + 2))}`,
      schema: RegimeDraftSchema,
      jsonSchema: THESIS_SCHEMA as never,
      promptVersion: REGIME_PROMPT_VERSION,
      webSearch: true,
      maxUses: REGIME_MAX_SEARCHES,
      deadlineMs: REGIME_DEADLINE_MS,
      hooks: {
        onSearchResults: (rs) => {
          for (const x of rs) if (!searched.has(x.url)) searched.set(x.url, { title: x.title ?? x.url, url: x.url });
        },
      },
      deps: deps.llm,
    });
    if (!r.ok) return { status: "failed", error: `The rewrite failed (${r.error}); the previous version stands.`, notes };

    const seenLinks: Link[] = [...searched.values(), ...read.flatMap((e) => (e.url ? [{ title: e.title, url: e.url }] : []))];
    const thesis = buildThesis(r.value, {
      now: iso,
      model: r.trace.model ?? "unknown",
      id: crypto.randomUUID(),
      previous,
      seen: seenLinks,
      evidenceIds: read.map((e) => e.id),
      usage: { input_tokens: r.trace.usage.input_tokens, output_tokens: r.trace.usage.output_tokens, web_searches: r.trace.searches },
    });
    if (!thesis.tldr && !thesis.source_reads.length) return { status: "failed", error: "The model returned an empty thesis; the previous version stands.", notes };
    await deps.store.save(thesis);
    await deps.store.remember(
      read.filter(isReport).map((e) => e.id),
      now,
    );
    return { status: "written", thesis, notes };
  } finally {
    await deps.store.unlock();
  }
}

/** A seed file's shape: a thesis body plus the changelog rows that came before it. Kept outside the repo. */
export type SeedFile = Record<string, unknown> & { history?: Array<Omit<HistoryEntry, "id"> & { id?: string }> };

export class RegimeSeedError extends Error {}

/** Writes the first version from a seed document (notes already shaped). Refuses over an existing thesis unless forced. */
export async function seedRegime(store: RegimeStore, seed: SeedFile, opts: { force?: boolean; now: Date }): Promise<RegimeThesis> {
  if ((await store.thesis()) && !opts.force) throw new RegimeSeedError("A thesis already exists; pass --force to replace it with the seed.");
  const fallback = opts.now.toISOString();
  const created = typeof seed.created === "string" && Number.isFinite(Date.parse(seed.created)) ? new Date(seed.created).toISOString() : fallback;
  const t = buildSeed(seed, { now: created, id: crypto.randomUUID() });
  const older: HistoryEntry[] = (Array.isArray(seed.history) ? seed.history : []).map((h, i) => ({
    id: h.id ?? `seed-${created.slice(0, 10)}-${i}`,
    version: 0,
    created: h.created,
    phase: h.phase,
    stance: h.stance,
    conviction: h.conviction,
    consensus: h.consensus ?? null,
    changelog: h.changelog,
  }));
  await store.save(
    t,
    older.filter((h) => h.created && h.phase && h.changelog && h.created < created),
  );
  return t;
}
