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

/** Response bodies above this are refused (streamed, so the cap holds without a content-length). */
export const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const TEXTISH = /^(text\/[\w.+-]+|application\/([\w.-]+\+)?(json|xml))$/;

/**
 * GET/POST with a timeout; non-2xx throws `HTTP <status>`. A declared
 * content type must be text-ish (text/*, JSON, XML; an absent header is read,
 * since some feeds omit it) and the body is capped at MAX_FETCH_BYTES.
 */
export async function fetchText(f: typeof fetch, url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await f(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type && !TEXTISH.test(type)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`unsupported content-type: ${type}`);
  }
  return readCapped(res, MAX_FETCH_BYTES);
}

/** Streams the body, aborting once it passes `max` bytes (a declared content-length over `max` is refused up front). */
export async function readCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error("response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
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

/**
 * Tags → " ", or "\n" for tag names in `breaks`. A linear indexOf scan (no
 * regex backtracking: feeds and pages are untrusted, and `<[^>]*>` over many
 * unclosed `<` is quadratic). An unclosed `<` stays text, like the regex did.
 */
export function stripTags(s: string, breaks: ReadonlySet<string> = BR): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    const gt = lt < 0 ? -1 : s.indexOf(">", lt + 1);
    if (gt < 0) {
      out.push(s.slice(i));
      return out.join("");
    }
    const name = /^\/?([a-z][a-z0-9]*)/i.exec(s.slice(lt + 1, Math.min(gt, lt + 16)))?.[1]?.toLowerCase();
    out.push(s.slice(i, lt), name && breaks.has(name) ? "\n" : " ");
    i = gt + 1;
  }
}
const BR: ReadonlySet<string> = new Set(["br"]);

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
