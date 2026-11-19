import { describe, expect, test } from "bun:test";
import { buildThesis, urlKey } from "./build.js";
import { consensus, labelFor } from "./consensus.js";
import { renderThesis } from "./render.js";
import { RegimeDraftSchema, RegimeThesisSchema } from "./schema.js";
import { sourceFor, weightFor } from "./sources.js";
import { articleText, isoWeek, parseFeed, sitemapUrls, weekOnchainSlug } from "./text.js";
import type { SourceRead } from "./types.js";

// The regime thesis core (docs/REGIME.md): feed and page parsing, ISO weeks, the weighted consensus, building a
// version from the model's JSON (URLs limited to what was seen), the Markdown, and the zod contracts. No network.
// The same cases as tradespace's test/intel.test.ts, which carries the same core files.

const NOW = Date.UTC(2026, 10, 19, 6, 53);
const iso = new Date(NOW).toISOString();

const read = (over: Partial<SourceRead>): SourceRead => ({ source: "x", name: "X", kind: "flows", lean: 0, confidence: 1, claim: "c", url: null, as_of: null, weight: 1, ...over });

// ---------- text ----------

describe("text", () => {
  test("RSS and Atom items, CDATA, entities, tracking-free links", () => {
    const rss = `<rss><channel><item><title><![CDATA[Capitulation &amp; Support]]></title><link>https://research.glassnode.com/the-week-onchain-week-46-2026/</link><pubDate>Tue, 17 Nov 2026 16:00:00 GMT</pubDate><description>&lt;p&gt;Losses at &lt;b&gt;cycle-low&lt;/b&gt; levels&lt;/p&gt;</description></item></channel></rss>`;
    const [it] = parseFeed(rss);
    expect(it).toEqual({ title: "Capitulation & Support", url: "https://research.glassnode.com/the-week-onchain-week-46-2026/", published: "2026-11-17T16:00:00.000Z", summary: "Losses at cycle-low levels" });
    const atom = `<feed><entry><title>Flows</title><link rel="alternate" href="https://k33.com/research/flows"/><updated>2026-11-18T08:00:00Z</updated><summary>ETF outflows slow</summary></entry></feed>`;
    expect(parseFeed(atom)[0]).toMatchObject({ title: "Flows", url: "https://k33.com/research/flows", published: "2026-11-18T08:00:00.000Z" });
    expect(parseFeed("not xml")).toEqual([]);
  });

  test("article text keeps the body and drops scripts and navigation", () => {
    const html = `<html><head><script>x()</script></head><body><nav>Menu</nav><article><h1>Week 46</h1><p>Realized loss hit 2022 levels.</p><ul><li>$62K-$66K block</li></ul></article><footer>f</footer></body></html>`;
    expect(articleText(html)).toBe("Week 46\nRealized loss hit 2022 levels.\n- $62K-$66K block");
    expect(articleText(`<article>${"a".repeat(50)}</article>`, 10)).toContain("[…cut at 10 characters]");
  });

  test("ISO weeks and Glassnode's slug", () => {
    expect(isoWeek(Date.UTC(2026, 10, 17))).toEqual({ year: 2026, week: 47 });
    expect(isoWeek(Date.UTC(2021, 0, 1))).toEqual({ year: 2020, week: 53 });
    expect(isoWeek(Date.UTC(2026, 0, 1))).toEqual({ year: 2026, week: 1 });
    expect(weekOnchainSlug(Date.UTC(2026, 10, 12))).toBe("the-week-onchain-week-46-2026");
    expect(sitemapUrls("<urlset><url><loc> https://a.example/x/ </loc></url></urlset>")).toEqual(["https://a.example/x/"]);
  });
});

// ---------- consensus ----------

describe("consensus", () => {
  test("weighted mean, labels and agreement", () => {
    expect(labelFor(-1.3)).toBe("bearish");
    expect(labelFor(0)).toBe("mixed");
    expect(labelFor(0.5)).toBe("lean bullish");
    expect(consensus([read({ lean: -1 }), read({ lean: -1 })]).agreement).toBe("thin");
    const aligned = consensus([read({ source: "a", lean: -1 }), read({ source: "b", lean: -1 }), read({ source: "c", lean: -2, weight: 0.5 })]);
    expect(aligned).toMatchObject({ agreement: "aligned", label: "lean bearish", n: 3 });
    expect(aligned.score).toBeCloseTo(-1.2, 2);
    const contested = consensus([read({ source: "a", lean: 2 }), read({ source: "b", lean: -2 }), read({ source: "c", lean: 1 })]);
    expect(contested.agreement).toBe("contested");
  });

  test("the reference is compared with the rest of the field", () => {
    const agrees = consensus([read({ source: "glassnode", lean: -1 }), read({ source: "a", lean: -1 }), read({ source: "b", lean: -2 })]);
    expect(agrees.reference).toEqual({ source: "glassnode", lean: -1 });
    expect(agrees.reference_vs_field).toBe("agrees");
    const differs = consensus([read({ source: "glassnode", lean: 2 }), read({ source: "a", lean: -1 }), read({ source: "b", lean: -2 })]);
    expect(differs.reference_vs_field).toBe("differs");
    expect(consensus([read({ source: "a", lean: 1 })]).reference_vs_field).toBe("no_reference");
    expect(consensus([read({ source: "glassnode", lean: 1 })]).reference_vs_field).toBe("no_field");
    expect(consensus([]).score).toBe(0);
  });

  test("weights come from the catalog, by id or by host, else by kind", () => {
    expect(weightFor("glassnode", "onchain_research")).toBe(1);
    expect(sourceFor("web:farside.co.uk")?.id).toBe("farside");
    expect(sourceFor("anything", "https://www.coindesk.com/markets/x")?.id).toBe("coindesk");
    expect(weightFor("web:unknown.example", "macro")).toBe(0.7);
  });
});

// ---------- build ----------

const MODEL_JSON = {
  phase: "Capitulation, base forming above $60K",
  stance: "defensive",
  conviction: "medium",
  tldr: "BTC holds the August block.",
  macro: "Yields above 5%.",
  alts: "Washout.",
  key_levels: [{ metric: "STH cost basis", level: "$74.1K", price: 74100, meaning: "Bottom confirmation", status: "lost", sources: ["glassnode"], as_of: "2026-11-17" }, { metric: "", level: "x", price: null, meaning: "", status: "", sources: [], as_of: null }],
  lines: [{ kind: "bear_trigger", text: "Daily close below $62K", price: 62000 }],
  scenarios: [
    { name: "Base", probability: 40, path: "Sweep then hold", trigger: "Bids hold" },
    { name: "Deeper", probability: 60, path: "To $53.7K", trigger: "Close below $58.5K" },
  ],
  source_reads: [
    { source: "glassnode", name: "Glassnode", kind: "onchain_research", lean: 0, confidence: 0.9, claim: "Capitulation meets support.", url: "https://research.glassnode.com/the-week-onchain-week-46-2026/?utm_source=x", as_of: "2026-11-17" },
    { source: "web:farside.co.uk", name: "Farside", kind: "flows", lean: -1, confidence: 0.7, claim: "ETF outflows continue.", url: "https://farside.co.uk/btc/", as_of: "2026-11-18" },
    { source: "made-up", name: "Invented", kind: "analyst", lean: 5, confidence: 3, claim: "Moon.", url: "https://invented.example/x", as_of: null },
    { source: "glassnode", name: "Glassnode again", kind: "onchain_research", lean: -2, confidence: 0.2, claim: "Duplicate.", url: null, as_of: null },
  ],
  agreement_notes: "Flows disagree with the on-chain tone.",
  catalysts: [{ date: "2026-12-09", event: "FOMC", why: "Hike priced", status: "upcoming" }],
  narratives: [{ name: "AI compute", read: "Thin." }],
  changes: [{ what: "Phase", from: "Floor giving way", to: "Capitulation", because: "Glassnode Week 46", sources: ["glassnode"] }],
  changelog: "Downgraded on the breakdown.",
  source_urls: ["https://farside.co.uk/btc", "https://never-seen.example/"],
};

describe("buildThesis", () => {
  const seen = [
    { title: "Glassnode W46", url: "https://research.glassnode.com/the-week-onchain-week-46-2026/" },
    { title: "Farside", url: "https://farside.co.uk/btc/" },
  ];
  const t = buildThesis(MODEL_JSON, { now: iso, model: "m", id: "t1", previous: null, seen, evidenceIds: ["e1"], usage: { input_tokens: 1, output_tokens: 2, web_searches: 3 } });

  test("checks, clamps, merges and counts", () => {
    expect(t.version).toBe(1);
    expect(t.key_levels).toHaveLength(1);
    expect(t.scenarios.map((s) => s.probability)).toEqual([0.4, 0.6]);
    const byId = Object.fromEntries(t.source_reads.map((r) => [r.source, r]));
    expect(Object.keys(byId).sort()).toEqual(["farside", "glassnode", "made-up"]);
    expect(byId.glassnode).toMatchObject({ lean: 0, confidence: 0.9, weight: 1 });
    expect(byId.farside!.weight).toBe(0.85);
    expect(byId["made-up"]).toMatchObject({ lean: 2, confidence: 1, url: null, weight: 0.55 });
  });

  test("URLs only from what the run saw", () => {
    expect(t.sources.map((l) => l.url)).toEqual(["https://farside.co.uk/btc/", "https://research.glassnode.com/the-week-onchain-week-46-2026/"]);
    expect(urlKey("https://A.example/x/?utm_source=y#z")).toBe("https://a.example/x");
  });

  test("the consensus is computed, and the next version counts on", () => {
    expect(t.consensus.reference).toEqual({ source: "glassnode", lean: 0 });
    expect(t.consensus.n).toBe(3);
    const next = buildThesis({ ...MODEL_JSON, stance: "nonsense" }, { now: iso, model: "m", id: "t2", previous: t, seen, evidenceIds: [], usage: t.usage });
    expect(next.version).toBe(2);
    expect(next.stance).toBe("defensive");
  });

  test("renders like the Weekly Tape", () => {
    const md = renderThesis(t);
    expect(md).toContain("# Regime thesis v1");
    expect(md).toContain("**Capitulation, base forming above $60K**");
    expect(md).toContain("## How the sources lean");
    expect(md).toContain("**Reference, Glassnode: neutral;");
    expect(md).toContain("**Triggers the bear case:** Daily close below $62K");
    expect(md).not.toContain("invented.example");
  });
});


describe("zod contracts", () => {
  const seen = [{ title: "Glassnode W46", url: "https://research.glassnode.com/the-week-onchain-week-46-2026/" }];
  test("the model's draft passes; an empty one does not", () => {
    expect(RegimeDraftSchema.safeParse(MODEL_JSON).success).toBe(true);
    expect(RegimeDraftSchema.safeParse({ ...MODEL_JSON, source_reads: [] }).success).toBe(false);
    expect(RegimeDraftSchema.safeParse({ ...MODEL_JSON, stance: "moon" }).success).toBe(false);
  });
  test("a built thesis passes the stored-thesis schema", () => {
    const t = buildThesis(MODEL_JSON, { now: iso, model: "m", id: "t1", previous: null, seen, evidenceIds: [], usage: { input_tokens: 0, output_tokens: 0, web_searches: 0 } });
    const r = RegimeThesisSchema.safeParse(t);
    expect(r.success).toBe(true);
    expect(RegimeThesisSchema.safeParse({ ...t, consensus: { ...t.consensus, agreement: "maybe" } }).success).toBe(false);
  });
});
