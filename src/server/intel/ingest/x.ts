import { z } from "zod";
import type { NewEvent } from "../store.js";
import { fetchText, fresh, headlineEvent, message, pastIso, SKIPPED_NO_KEY, type AdapterResult, type IngestDeps } from "./common.js";

// X list timeline (SPEC.md § Intel I0.10), behind X_BEARER_TOKEN +
// INTEL_X_LIST_ID; either missing → skipped:no-key.

export const X_API = "https://api.twitter.com/2";

const ListTweetsSchema = z.object({
  data: z
    .array(z.object({ id: z.string().regex(/^\d{1,30}$/), text: z.string(), created_at: z.string().optional(), author_id: z.string().optional() }))
    .optional(),
  includes: z.object({ users: z.array(z.object({ id: z.string(), username: z.string().regex(/^\w{1,30}$/) })).optional() }).optional(),
});

/** Pure: list-tweets response → events. */
export function parseXList(json: unknown, now: Date): NewEvent[] {
  const parsed = ListTweetsSchema.parse(json);
  const users = new Map((parsed.includes?.users ?? []).map((u) => [u.id, u.username]));
  const out: NewEvent[] = [];
  for (const t of parsed.data ?? []) {
    const text = t.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const firstSeen = pastIso(t.created_at, now) ?? now.toISOString();
    if (!fresh(firstSeen, now)) continue;
    const user = t.author_id ? users.get(t.author_id) : undefined;
    out.push(
      headlineEvent({
        key: `x:${t.id}`,
        title: text.slice(0, 280),
        summary: null,
        url: user ? `https://x.com/${user}/status/${t.id}` : `https://x.com/i/web/status/${t.id}`,
        label: user ? `X @${user}` : "X",
        origin: "x",
        firstSeen,
      }),
    );
  }
  return out;
}

export async function fetchX(deps: Pick<IngestDeps, "fetch" | "env" | "now" | "signal">): Promise<AdapterResult> {
  const token = deps.env.X_BEARER_TOKEN?.trim();
  const list = deps.env.INTEL_X_LIST_ID?.trim();
  if (!token || !list) return { source: "x", ok: true, items: [], error: SKIPPED_NO_KEY };
  if (!/^\d{1,30}$/.test(list)) return { source: "x", ok: false, items: [], error: "INTEL_X_LIST_ID must be numeric" };
  try {
    const body = await fetchText(
      deps.fetch,
      `${X_API}/lists/${list}/tweets?max_results=50&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`,
      { headers: { authorization: `Bearer ${token}` } },
      deps.signal,
    );
    return { source: "x", ok: true, items: parseXList(JSON.parse(body), deps.now()) };
  } catch (e) {
    return { source: "x", ok: false, items: [], error: message(e).slice(0, 500) };
  }
}
