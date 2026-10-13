import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EmitProvider, llmDeps } from "../fixtures/emit-provider.js";
import { MemoryIntelStore } from "../store.js";
import { decodeEntities, fetchText, MAX_FETCH_BYTES, recordRun } from "./common.js";
import { DEFAULT_SNAPSHOT_SPACES, fetchGovernance, parseSnapshotProposals, snapshotSpaces } from "./governance.js";
import { feedUrls, fetchRss, parseFeed } from "./rss.js";
import { fetchTelegram, parseTelegramChannel, tgChannels } from "./telegram.js";
import { fetchWebsearch, sweepEvents, WEBSEARCH_SETTING } from "./websearch.js";
import { fetchX, parseXList } from "./x.js";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8");
const now = new Date("2026-10-13T12:00:00Z");
const fakeFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => (async (u: unknown, init?: RequestInit) => handler(String(u), init)) as unknown as typeof fetch;

describe("parseFeed", () => {
  test("RSS 2.0: CDATA, entities, markup, dc:date, empty titles skipped", () => {
    const items = parseFeed(fixture("rss2.xml"));
    expect(items).toEqual([
      {
        title: "Jito restaking vault exploited for $10M & counting",
        link: "https://news.example.com/jito-exploit",
        guid: "jito-1234",
        published: "2026-10-13T09:30:00.000Z",
        summary: "Attackers drained jitoSOL from a vault & bridged out.",
      },
      {
        title: "SEC & CFTC issue joint statement on “perp” venues",
        link: "https://news.example.com/sec-cftc",
        guid: null,
        published: "2026-10-13T08:00:00.000Z",
        summary: "Regulators said more is coming…",
      },
    ]);
  });

  test("Atom: alternate link over self, id, published over updated, content fallback", () => {
    expect(parseFeed(fixture("atom.xml"))).toEqual([
      {
        title: "USDe supply drops 8% as funding turns negative",
        link: "https://blog.example.org/usde-supply?a=1&b=2",
        guid: "tag:blog.example.org,2026:entry-42",
        published: "2026-10-13T05:15:00.000Z",
        summary: "Redemptions picked up",
      },
      {
        title: "Hyperliquid upgrade scheduled",
        link: "https://blog.example.org/hl-upgrade",
        guid: "urn:uuid:7f1c",
        published: "2026-10-12T22:00:00.000Z",
        summary: "Validators vote on HIP-9 next week.",
      },
    ]);
  });

  test("linear on hostile feeds: 1 MB of unclosed <item> / <entry> / CDATA / <title> / <link completes fast", () => {
    const MB = 1024 * 1024;
    const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length));
    const ok = "<item><title>Real headline</title></item>";
    const cases = [
      fill("<item>"),
      fill("<entry>"),
      fill("<item><title>"),
      `<item><title>${fill("<![CDATA[")}</title></item>`,
      `<item><title>${fill("<title>")}</title></item>`,
      `<item><title>x</title><description>${fill("<")}</description></item>`,
      `<entry><title>x</title>${fill("<link ")}</entry>`,
      `<entry><title>x</title>${fill('<link rel="')}></entry>`,
    ];
    for (const [i, xml] of cases.entries()) {
      const t0 = performance.now();
      const items = parseFeed(ok + xml);
      expect([i, performance.now() - t0 < 500]).toEqual([i, true]);
      expect(items[0]?.title).toBe("Real headline");
    }
  });

  test("decodeEntities leaves unknown and out-of-range references alone", () => {
    expect(decodeEntities("&amp;&#65;&#x42;&bogus;&#9999999;")).toBe("&AB&bogus;&#9999999;");
  });
});

describe("fetchText", () => {
  test("streams with a 5 MB cap and refuses non-text content types", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(512 * 1024).fill(97);
    const endless = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            pull(ctl) {
              pulled++;
              ctl.enqueue(chunk);
            },
          }),
          { headers: { "content-type": "application/rss+xml" } },
        ),
    );
    await expect(fetchText(endless, "https://a.example.com/rss")).rejects.toThrow(/too large/);
    expect(pulled * chunk.byteLength).toBeLessThan(MAX_FETCH_BYTES + 3 * chunk.byteLength);
    const declared = fakeFetch(() => new Response("x", { headers: { "content-type": "text/xml", "content-length": String(MAX_FETCH_BYTES + 1) } }));
    await expect(fetchText(declared, "https://a.example.com/rss")).rejects.toThrow(/too large/);
    for (const type of ["application/octet-stream", "image/png", "application/pdf"]) {
      await expect(fetchText(fakeFetch(() => new Response("x", { headers: { "content-type": type } })), "https://a.example.com/")).rejects.toThrow(`unsupported content-type: ${type}`);
    }
    for (const type of ["text/html; charset=utf-8", "application/json", "application/atom+xml", "application/ld+json", "text/xml"]) {
      expect(await fetchText(fakeFetch(() => new Response("ok", { headers: { "content-type": type } })), "https://a.example.com/")).toBe("ok");
    }
  });
});

describe("fetchRss", () => {
  test("feeds → observed headline events; one failing feed is reported, the rest still count", async () => {
    const r = await fetchRss({
      env: { INTEL_RSS_FEEDS: "https://news.example.com/rss, https://down.example.com/feed, ftp://nope" },
      now: () => now,
      fetch: fakeFetch((u) => (u.includes("down") ? new Response("", { status: 503 }) : new Response(fixture("rss2.xml")))),
    });
    expect(r).toMatchObject({ source: "rss", ok: false, error: "down.example.com: HTTP 503" });
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ type: "other", origin: "rss", tag: "observed", firstSeen: "2026-10-13T09:30:00.000Z", sources: [{ label: "news.example.com", url: "https://news.example.com/jito-exploit" }] });
    expect(r.items[0]!.key).toMatch(/^rss:[0-9a-f]{24}$/);
    expect(feedUrls({}).length).toBeGreaterThan(2);
  });

  test("items older than 48 h are not ingested", async () => {
    const r = await fetchRss({ env: { INTEL_RSS_FEEDS: "https://a.example.com/rss" }, now: () => new Date("2026-10-20T00:00:00Z"), fetch: fakeFetch(() => new Response(fixture("rss2.xml"))) });
    expect(r).toMatchObject({ ok: true, items: [] });
  });
});

describe("governance", () => {
  test("proposals → governance events with the vote end as scheduledAt; unmapped spaces ignored", () => {
    const events = parseSnapshotProposals(JSON.parse(fixture("snapshot-proposals.json")), DEFAULT_SNAPSHOT_SPACES, now);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      key: "snapshot:0xabc123",
      type: "governance",
      title: "Aave: [ARFC] Raise wstETH supply cap on Aave v3",
      summary: "Snapshot vote, active.",
      entities: ["Aave", "AAVE"],
      assets: ["AAVE"],
      magnitude: "low",
      sources: [{ label: "Snapshot aave.eth", url: "https://snapshot.box/#/s:aave.eth/proposal/0xabc123" }],
      origin: "governance",
      firstSeen: new Date(1791800000 * 1000).toISOString(),
      scheduledAt: new Date(1792150000 * 1000).toISOString(),
      catalyst: null,
      tag: "observed",
    });
    expect(events[1]!.sources[0]!.url).toBe("https://snapshot.org/#/arbitrumfoundation.eth/proposal/0xdef456");
  });

  test("INTEL_SNAPSHOT_SPACES replaces the map and drops malformed pairs", () => {
    expect(snapshotSpaces({ INTEL_SNAPSHOT_SPACES: "AAVE=aave.eth, bad pair, $X=y.eth, UNI=uniswapgovernance.eth" })).toEqual({ AAVE: "aave.eth", UNI: "uniswapgovernance.eth" });
  });

  test("posts the GraphQL query with the mapped spaces; HTTP errors are reported", async () => {
    let sent: { variables: { spaces: string[]; since: number } } | null = null;
    const ok = await fetchGovernance({
      env: { INTEL_SNAPSHOT_SPACES: "AAVE=aave.eth" },
      now: () => now,
      fetch: fakeFetch((_u, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(fixture("snapshot-proposals.json"));
      }),
    });
    expect(ok).toMatchObject({ source: "governance", ok: true });
    expect(ok.items.map((e) => e.key)).toEqual(["snapshot:0xabc123"]);
    expect(sent!.variables.spaces).toEqual(["aave.eth"]);
    const bad = await fetchGovernance({ env: {}, now: () => now, fetch: fakeFetch(() => new Response("", { status: 429 })) });
    expect(bad).toMatchObject({ ok: false, items: [], error: "HTTP 429" });
  });
});

describe("telegram", () => {
  test("parses message text, link and time; skips media-only and stale posts", () => {
    const events = parseTelegramChannel(fixture("telegram.html"), "wublockchain", now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: "tg:wublockchain/41001",
      title: "Binance will delist XYZ perps on Oct 20 & close positions. Details: link",
      firstSeen: "2026-10-13T06:00:00.000Z",
      sources: [{ label: "Telegram @wublockchain", url: "https://t.me/wublockchain/41001" }],
      origin: "telegram",
      tag: "observed",
    });
  });

  test("gated on INTEL_TG_CHANNELS; a blocked channel is recorded as a failure", async () => {
    expect(await fetchTelegram({ env: {}, now: () => now, fetch: fakeFetch(() => new Response("")) })).toMatchObject({ ok: true, error: "skipped:no-channels" });
    expect(tgChannels({ INTEL_TG_CHANNELS: "@wublockchain, bad/../x, ok_chan" })).toEqual(["wublockchain", "ok_chan"]);
    const calls: string[] = [];
    const r = await fetchTelegram({
      env: { INTEL_TG_CHANNELS: "wublockchain,blocked_one" },
      now: () => now,
      fetch: fakeFetch((u) => {
        calls.push(u);
        return new Response(u.includes("blocked") ? "<html>Please verify</html>" : fixture("telegram.html"));
      }),
    });
    expect(r).toMatchObject({ ok: false, error: "blocked_one: no messages in page (blocked?)" });
    expect(r.items).toHaveLength(1);
    expect(calls).toHaveLength(2); // no retry
  });
});

describe("x", () => {
  test("skipped:no-key without the token or list id", async () => {
    expect(await fetchX({ env: { X_BEARER_TOKEN: "t" }, now: () => now, fetch: fakeFetch(() => new Response("")) })).toEqual({ source: "x", ok: true, items: [], error: "skipped:no-key" });
  });

  test("list tweets → events linked to the author's status URL, bearer sent", async () => {
    let auth = "";
    const body = {
      data: [
        { id: "1845", text: "Hyperliquid  validators\nvote on HIP-9", created_at: "2026-10-13T11:00:00Z", author_id: "9" },
        { id: "1846", text: "no author", created_at: "2026-10-13T11:05:00Z" },
      ],
      includes: { users: [{ id: "9", username: "hl_news" }] },
    };
    const r = await fetchX({
      env: { X_BEARER_TOKEN: "secret", INTEL_X_LIST_ID: "123" },
      now: () => now,
      fetch: fakeFetch((_u, init) => {
        auth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(JSON.stringify(body));
      }),
    });
    expect(auth).toBe("Bearer secret");
    expect(r.items.map((e) => [e.key, e.title, e.sources[0]!.url])).toEqual([
      ["x:1845", "Hyperliquid validators vote on HIP-9", "https://x.com/hl_news/status/1845"],
      ["x:1846", "no author", "https://x.com/i/web/status/1846"],
    ]);
    expect(parseXList({}, now)).toEqual([]);
  });
});

describe("websearch", () => {
  const sweep = {
    headlines: [
      { title: "Exchange halts withdrawals", url: "https://news.example.com/halt", publishedAt: "2026-10-13T10:00:00Z" },
      { title: "Rumour: big fund rotates into SOL" },
    ],
    catalysts: [
      { title: "ARB unlock of 92M tokens", type: "unlock", assets: ["$ARB", "not a ticker!"], scheduledAt: "2026-10-16T13:00:00Z", size: "92M ARB", directionHypothesis: "down" },
      { title: "Bad date", type: "listing", assets: [], scheduledAt: "soon" },
    ],
  };

  test("items without a URL are hypotheses; catalysts keep a scheduled time and ticker assets", () => {
    const events = sweepEvents(sweep as never, now);
    expect(events.map((e) => [e.title, e.tag])).toEqual([
      ["Exchange halts withdrawals", "observed"],
      ["Rumour: big fund rotates into SOL", "hypothesis"],
      ["ARB unlock of 92M tokens", "hypothesis"],
    ]);
    expect(events[1]!.sources).toEqual([{ label: "LLM web search (no URL)" }]);
    expect(events[2]).toMatchObject({ type: "unlock", assets: ["ARB"], scheduledAt: "2026-10-16T13:00:00.000Z", catalyst: { size: "92M ARB", directionHypothesis: "down" } });
  });

  test("gated on INTEL_WEBSEARCH, at most hourly, strong tier with web search", async () => {
    const store = new MemoryIntelStore();
    const provider = new EmitProvider(() => sweep);
    const deps = { store, llm: llmDeps(provider, store), env: { INTEL_WEBSEARCH: "true" }, now: () => now, targets: async () => ["SOL", "HYPE"] };
    expect(await fetchWebsearch({ ...deps, env: {} })).toMatchObject({ ok: true, error: "skipped:disabled" });
    const r = await fetchWebsearch(deps);
    expect(r).toMatchObject({ source: "websearch", ok: true });
    expect(r.items).toHaveLength(3);
    expect(provider.opts[0]!.webSearch).toBe(true);
    expect(provider.prompts[0]).toContain("SOL, HYPE");
    expect(await store.getSetting<string>(WEBSEARCH_SETTING)).toBe(now.toISOString());
    expect(await fetchWebsearch({ ...deps, now: () => new Date(now.getTime() + 30 * 60_000) })).toMatchObject({ ok: true, items: [], error: "skipped:throttled" });
    expect(provider.prompts).toHaveLength(1);
  });
});

describe("recordRun", () => {
  test("writes intel:<source> and swallows recorder errors", async () => {
    const rows: unknown[][] = [];
    const t = new Date();
    await recordRun({ source: "rss", ok: false, error: "x: HTTP 500" }, t, async (...a) => void rows.push(a));
    await recordRun({ source: "x", ok: true }, t, async () => {
      throw new Error("db down");
    });
    expect(rows).toEqual([["intel:rss", t, false, "x: HTTP 500"]]);
  });
});
