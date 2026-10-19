import { decodeEntities, fetchText, fresh, hashKey, headlineEvent, hostLabel, message, pastIso, plain, type AdapterResult, type IngestDeps } from "./common.js";

// RSS 2.0 + Atom (docs/SPEC.md § Intel I0.10). A small regex parser on purpose (no
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

/**
 * Inner text of each `<tag …>…</tag>` (not nested), in order, at most `limit`.
 * A linear indexOf scan: feeds are untrusted and lazy `[\s\S]*?` regexes go
 * quadratic on many unclosed openers. Once an opener has no `>` or no closer,
 * no later one can have either, so the scan stops.
 */
function elements(xml: string, tag: string, limit = Infinity): string[] {
  const open = new RegExp(`<${tag}(?=[\\s>])`, "gi");
  const close = new RegExp(`</${tag}>`, "gi");
  const out: string[] = [];
  for (let m = open.exec(xml); m && out.length < limit; m = open.exec(xml)) {
    const gt = xml.indexOf(">", open.lastIndex);
    if (gt < 0) break;
    close.lastIndex = gt + 1;
    const c = close.exec(xml);
    if (!c) break;
    out.push(xml.slice(gt + 1, c.index));
    open.lastIndex = c.index + c[0].length;
  }
  return out;
}

const inner = (body: string, tag: string): string | null => elements(body, tag, 1)[0] ?? null;

/** CDATA sections → their literal text, re-escaped so the entity decode below is a no-op on it. Linear. */
function unwrapCdata(raw: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = raw.indexOf("<![CDATA[", i);
    const b = a < 0 ? -1 : raw.indexOf("]]>", a + 9);
    if (b < 0) break;
    out.push(raw.slice(i, a), raw.slice(a + 9, b).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    i = b + 3;
  }
  out.push(raw.slice(i));
  return out.join("");
}

/** Element text: CDATA is literal, anything else is entity-encoded; either may hold HTML. */
function text(raw: string | null, max: number): string | null {
  if (raw == null) return null;
  const s = plain(decodeEntities(unwrapCdata(raw)), max);
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

/** `<link …>` tags, linear; tags over 2 KB are skipped (the attr regex would rescan them). */
function linkTags(body: string): string[] {
  const open = /<link\b/gi;
  const out: string[] = [];
  for (let m = open.exec(body); m; m = open.exec(body)) {
    const gt = body.indexOf(">", open.lastIndex);
    if (gt < 0) break;
    if (gt - m.index <= 2048) out.push(body.slice(m.index, gt + 1));
    open.lastIndex = gt + 1;
  }
  return out;
}

function atomLink(body: string): string | null {
  const links = linkTags(body);
  const pick = links.find((l) => !attr(l, "rel") || attr(l, "rel") === "alternate") ?? links[0];
  return pick ? attr(pick, "href") : null;
}

export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const b of elements(xml, "item")) {
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
  for (const b of elements(xml, "entry")) {
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
