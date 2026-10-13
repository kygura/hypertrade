import { createHash } from "node:crypto";
import { recordCollectorRun } from "../../db.js";
import type { LlmDeps } from "../llm.js";
import type { IntelStore, NewEvent } from "../store.js";

// Shared plumbing for the ingest adapters (SPEC.md § Intel I0.10). Every
// adapter returns an AdapterResult and never throws; runIngestSources
// (index.ts) records one collector_runs row per source as `intel:<source>`.

export interface IngestDeps {
  store: IntelStore;
  llm: LlmDeps;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  now(): Date;
  /** Held ∪ watched assets (websearch focus). */
  targets(): Promise<string[]>;
  /** collector_runs writer; defaults to db.ts recordCollectorRun. */
  record?: RunRecorder;
  signal?: AbortSignal;
}

export interface AdapterResult {
  source: string;
  ok: boolean;
  items: NewEvent[];
  /** Failure, or a `skipped:*` reason on an ok result (the collectors' convention). */
  error?: string;
}

export type RunRecorder = (collector: string, startedAt: Date, ok: boolean, error?: string | null) => Promise<void>;

export const SKIPPED_NO_KEY = "skipped:no-key";
export const SKIPPED_DISABLED = "skipped:disabled";
export const SKIPPED_THROTTLED = "skipped:throttled";
/** Items older than this are not ingested: they would only spend extraction calls on stale news. */
export const MAX_ITEM_AGE_MS = 48 * 3600_000;
export const FETCH_TIMEOUT_MS = 15_000;

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Records `intel:<source>`; a failed write is logged, never thrown (it must not fail the run). */
export async function recordRun(result: Pick<AdapterResult, "source" | "ok" | "error">, startedAt: Date, record: RunRecorder = recordCollectorRun): Promise<void> {
  try {
    await record(`intel:${result.source}`, startedAt, result.ok, result.error ?? null);
  } catch (e) {
    console.warn(`[intel] collector_runs write failed for ${result.source}: ${message(e)}`);
  }
}

/** GET/POST with a timeout; non-2xx throws `HTTP <status>`. */
export async function fetchText(f: typeof fetch, url: string, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const res = await f(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const hashKey = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export const stripTags = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " ");

/** HTML fragment → one line of plain text, capped. */
export function plain(html: string, max: number): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim().slice(0, max);
}

/** A parseable date no later than now, as ISO; else null. */
export function pastIso(raw: string | null | undefined, now: Date): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (!Number.isFinite(t)) return null;
  return new Date(Math.min(t, now.getTime())).toISOString();
}

export const fresh = (iso: string, now: Date) => now.getTime() - Date.parse(iso) <= MAX_ITEM_AGE_MS;

export function hostLabel(url: string, fallback: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || fallback;
  } catch {
    return fallback;
  }
}

/** Unstructured headline → event; type and entities come later from cluster extraction. */
export function headlineEvent(e: { key: string; title: string; summary?: string | null; url: string | null; label: string; origin: NewEvent["origin"]; firstSeen: string }): NewEvent {
  return {
    key: e.key,
    type: "other",
    title: e.title,
    summary: e.summary || null,
    entities: [],
    assets: [],
    magnitude: "low",
    sources: [e.url ? { label: e.label, url: e.url } : { label: e.label }],
    origin: e.origin,
    firstSeen: e.firstSeen,
    scheduledAt: null,
    catalyst: null,
    tag: e.url ? "observed" : "hypothesis",
  };
}
