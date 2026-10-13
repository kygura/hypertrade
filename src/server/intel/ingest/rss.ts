import { decodeEntities, fetchText, fresh, hashKey, headlineEvent, hostLabel, message, pastIso, plain, type AdapterResult, type IngestDeps } from "./common.js";

// RSS 2.0 + Atom (SPEC.md § Intel I0.10). A small regex parser on purpose (no
// XML dependency): it reads the handful of fields a headline needs, unwraps
// CDATA, decodes entities and strips markup. Feeds come from INTEL_RSS_FEEDS
// (comma list) or the keyless defaults below.

export const DEFAULT_RSS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss/",
  "https://cointelegraph.com/rss",
  "https://www.theblock.co/rss.xml",
  "https://decrypt.co/feed",
  "https://blockworks.co/feed",
];

export interface FeedItem {
  title: string;
  link: string | null;
  guid: string | null;
  /** ISO, null when absent or unparseable. */
  published: string | null;
  summary: string | null;
}

function inner(body: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(body);
  return m ? m[1]! : null;
}

/** Element text: CDATA is literal, anything else is entity-encoded; either may hold HTML. */
function text(raw: string | null, max: number): string | null {
  if (raw == null) return null;
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  const s = plain(decodeEntities(unwrapped), max);
  return s || null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}

function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function atomLink(body: string): string | null {
  const links = body.match(/<link\b[^>]*>/gi) ?? [];
  const pick = links.find((l) => !attr(l, "rel") || attr(l, "rel") === "alternate") ?? links[0];
  return pick ? attr(pick, "href") : null;
}

export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1]!;
    const title = text(inner(b, "title"), 300);
    if (!title) continue;
    out.push({
      title,
      link: text(inner(b, "link"), 2000),
      guid: text(inner(b, "guid"), 500),
      published: isoDate(text(inner(b, "pubDate"), 100) ?? text(inner(b, "dc:date"), 100)),
      summary: text(inner(b, "description"), 600),
    });
  }
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const b = m[1]!;
    const title = text(inner(b, "title"), 300);
    if (!title) continue;
    out.push({
      title,
      link: atomLink(b),
      guid: text(inner(b, "id"), 500),
      published: isoDate(text(inner(b, "published"), 100) ?? text(inner(b, "updated"), 100)),
      summary: text(inner(b, "summary") ?? inner(b, "content"), 600),
    });
  }
  return out;
}

export function feedUrls(env: Record<string, string | undefined>): string[] {
  const raw = env.INTEL_RSS_FEEDS?.trim();
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_RSS_FEEDS;
  return list.filter((u) => /^https?:\/\//i.test(u));
}

export async function fetchRss(deps: Pick<IngestDeps, "fetch" | "env" | "now" | "signal">): Promise<AdapterResult> {
  const now = deps.now();
  const failures: string[] = [];
  const items: AdapterResult["items"] = [];
  await Promise.all(
    feedUrls(deps.env).map(async (url) => {
      try {
        const xml = await fetchText(deps.fetch, url, { headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } }, deps.signal);
        const label = hostLabel(url, "rss").slice(0, 120);
        for (const it of parseFeed(xml)) {
          const firstSeen = pastIso(it.published, now) ?? now.toISOString();
          if (!fresh(firstSeen, now)) continue;
          const link = it.link && /^https:\/\//i.test(it.link) ? it.link : null;
          items.push(headlineEvent({ key: `rss:${hashKey(it.guid ?? it.link ?? `${url}|${it.title}`)}`, title: it.title, summary: it.summary, url: link, label, origin: "rss", firstSeen }));
        }
      } catch (e) {
        failures.push(`${hostLabel(url, url)}: ${message(e)}`);
      }
    }),
  );
  return failures.length ? { source: "rss", ok: false, items, error: failures.join("; ").slice(0, 500) } : { source: "rss", ok: true, items };
}
