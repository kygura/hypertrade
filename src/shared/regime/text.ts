// Text plumbing for collectors: RSS/Atom items, HTML to readable text, ISO weeks (Glassnode names its weekly report
// "the-week-onchain-week-<week>-<year>"). Regex-based on purpose: no DOM dependency, and every function is total (bad
// input gives an empty result, never a throw).

export type FeedItem = { title: string; url: string; published: string | null; summary: string };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const unCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? unCdata(m[1]!).trim() : null;
}

/** HTML (or a fragment) to plain text: scripts, styles and navigation dropped, block tags as line breaks. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|figcaption|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<td[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** The article body of a blog page (Ghost: <article> / .gh-content / .post-content), else the whole page. */
export function articleText(html: string, max = 24_000): string {
  const pick =
    /<div[^>]+class="[^"]*\b(gh-content|post-content|article-content|entry-content)\b[^"]*"[^>]*>([\s\S]*)<\/div>/i.exec(html)?.[2] ??
    /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1] ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    html;
  const t = htmlToText(pick);
  return t.length > max ? `${t.slice(0, max)}\n[…cut at ${max} characters]` : t;
}

export const pageTitle = (html: string): string | null => {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html)?.[1];
  const t = og ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return t ? decodeEntities(t).trim() : null;
};

const isoDate = (s: string | null): string | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** RSS 2.0 <item>s or Atom <entry>s, in feed order. */
export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = decodeEntities(htmlToText(tag(b, "title") ?? ""));
    let url = tag(b, "link") ?? "";
    if (!/^https?:\/\//i.test(url)) url = /<link[^>]+href="([^"]+)"/i.exec(b)?.[1] ?? /<guid[^>]*>([^<]+)<\/guid>/i.exec(b)?.[1] ?? "";
    url = decodeEntities(url.trim());
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const published = isoDate(tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date"));
    const summary = htmlToText(decodeEntities(tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content") ?? "")).slice(0, 1500);
    out.push({ title, url, published, summary });
  }
  return out;
}

/** <loc>s of a sitemap. */
export const sitemapUrls = (xml: string): string[] => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]!));

/** ISO 8601 week and its year for a UTC time. */
export function isoWeek(ms: number): { year: number; week: number } {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / 86_400_000 / 7);
  return { year, week };
}

/** Glassnode's weekly report slug for a time ("the-week-onchain-week-46-2026"). */
export const weekOnchainSlug = (ms: number) => {
  const { year, week } = isoWeek(ms);
  return `the-week-onchain-week-${week}-${year}`;
};

/** Strip tracking parameters (utm_*, ref) so the same report is one URL. */
export function cleanUrl(u: string): string {
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|ref$|mc_)/i.test(k)) x.searchParams.delete(k);
    x.hash = "";
    return x.toString();
  } catch {
    return u;
  }
}
