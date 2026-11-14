import type { ExtremeEvent } from "../../shared/extremes.js";

// Wakes the research session for one job run's new extremes (docs/EXTREMES.md): one POST of `{ text }` to a Claude
// Code routine's fire endpoint (EXTREMES_WAKE_URL, `.../v1/claude_code/routines/trig_.../fire`) with the routine's
// bearer (EXTREMES_WAKE_TOKEN). The endpoint has no idempotency (a retry starts a second session) and allows 30 fires
// an hour, so there is one POST per job run and never a retry: a timeout or a non-2xx answer is a failed wake and the
// job pushes the facts instead. The text reaches the session as an untrusted payload, so it carries data only (lines,
// facts, keys) plus where the procedure and the verdict route are. The token is never logged.

type Env = Record<string, string | undefined>;

const WAKE_TIMEOUT_MS = 10_000;
/** The fire endpoint takes at most 65,536 characters of text. */
export const WAKE_TEXT_MAX = 60_000;
/** Sent unless EXTREMES_WAKE_HEADERS overrides them (it may also add headers). */
const DEFAULT_WAKE_HEADERS: Readonly<Record<string, string>> = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "experimental-cc-routine-2026-04-01",
};

/** The wake message: one block per event (key, line, facts as data), then the procedure pointer. Truncated below the endpoint's limit. */
export function wakeText(events: ExtremeEvent[], appUrl: string | null): string {
  const base = appUrl?.trim().replace(/\/+$/, "") || "$APP_URL";
  const blocks = events.map((e) =>
    [
      `key: ${e.key}`,
      `coin: ${e.coin}  kind: ${e.kind}  side: ${e.side}  window: ${e.window}  bar: ${e.ts}  mark: ${e.mark}  severity: ${e.severity}`,
      `line: ${e.line}`,
      `facts: ${JSON.stringify(e.facts)}`,
    ].join("\n"),
  );
  const head = `hypertrade extremes: ${events.length} new event(s)`;
  const tail = [
    "Procedure: docs/EXTREMES-ROUTINE.md in the hypertrade repository.",
    `Verdict: POST ${base}/api/extremes/verdict, one per key, body {key, stance, direction?, killPx?, cause, sources?} (Authorization: Bearer LAB_API_TOKEN).`,
  ].join("\n");
  const text = [head, ...blocks, tail].join("\n\n");
  if (text.length <= WAKE_TEXT_MAX) return text;
  // Too long: keep the head and tail, drop whole event blocks from the end, and say how many.
  const kept: string[] = [];
  let len = head.length + tail.length + 200;
  for (const b of blocks) {
    if (len + b.length + 2 > WAKE_TEXT_MAX) break;
    kept.push(b);
    len += b.length + 2;
  }
  return [head, ...kept, `(${blocks.length - kept.length} more event(s) omitted: GET ${base}/api/extremes)`, tail].join("\n\n").slice(0, WAKE_TEXT_MAX);
}

/**
 * EXTREMES_WAKE_HEADERS: a JSON object of string values, names lower-cased (so they replace the defaults rather than
 * add a second value). Authorization and content-type are the waker's own and dropped. Anything else is ignored with a
 * warning (never echoed: it may hold a secret).
 */
export function parseWakeHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string")) {
      const out: Record<string, string> = {};
      for (const [k, x] of Object.entries(v as Record<string, string>)) if (!/^(authorization|content-type)$/i.test(k)) out[k.toLowerCase()] = x;
      return out;
    }
  } catch {
    // fall through
  }
  console.warn("[extremes] EXTREMES_WAKE_HEADERS is not a JSON object of strings; ignored");
  return {};
}

export interface Waker {
  /** True when the session was started (2xx). False without a URL (no network call), on a timeout or any error. */
  wake(events: ExtremeEvent[]): Promise<boolean>;
}

export function createWaker(env: Env = process.env, fetchFn: typeof fetch = fetch): Waker {
  const url = env.EXTREMES_WAKE_URL?.trim();
  const token = env.EXTREMES_WAKE_TOKEN?.trim();
  const extra = parseWakeHeaders(env.EXTREMES_WAKE_HEADERS);
  return {
    async wake(events) {
      if (!url || !events.length) return false;
      if (!token) {
        console.warn("[extremes] EXTREMES_WAKE_URL is set without EXTREMES_WAKE_TOKEN; not waking");
        return false;
      }
      try {
        const r = await fetchFn(url, {
          method: "POST",
          headers: { ...DEFAULT_WAKE_HEADERS, ...extra, "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ text: wakeText(events, env.APP_URL ?? null) }),
          signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
        });
        if (!r.ok) {
          console.error(`[extremes] wake failed: HTTP ${r.status}`);
          return false;
        }
        const body = (await r.json().catch(() => null)) as { claude_code_session_url?: unknown } | null;
        console.log(`[extremes] woke a research session for ${events.length} event(s)${typeof body?.claude_code_session_url === "string" ? `: ${body.claude_code_session_url}` : ""}`);
        return true;
      } catch (err) {
        console.error("[extremes] wake failed:", err instanceof Error ? err.message : String(err));
        return false;
      }
    },
  };
}
