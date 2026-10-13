import { describe, expect, test } from "bun:test";
import type { WatchInput } from "../../shared/intel.js";
import {
  checkWatch,
  EIP1967_ADMIN_SLOT,
  EIP1967_IMPL_SLOT,
  htmlToText,
  isNonPublicIp,
  lineDiff,
  MAX_BODY_BYTES,
  rpcUrl,
  runIntelWatch,
  safeFetch,
  type DocwatchAlert,
  type DocwatchDeps,
  type FetchFn,
  type LookupFn,
} from "./docwatch.js";
import { EmitProvider, llmDeps } from "./fixtures/emit-provider.js";
import { MemoryIntelStore } from "./store.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const ADDR = "0x1111111111111111111111111111111111111111";
const IMPL_A = "0x" + "0".repeat(24) + "a".repeat(40);
const IMPL_B = "0x" + "0".repeat(24) + "b".repeat(40);
const ZERO = "0x" + "0".repeat(64);

/** Every host resolves to a public documentation address (no real DNS in tests). */
const publicDns: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

function harness(opts: { fetch: FetchFn; provider?: EmitProvider | null; routeAlert?: DocwatchDeps["routeAlert"] }) {
  const store = new MemoryIntelStore(() => NOW);
  const alerts: DocwatchAlert[] = [];
  const provider =
    opts.provider === undefined
      ? new EmitProvider(() => ({ summary: [{ tag: "hypothesis", text: "The proxy now points at new code." }, { tag: "observed", text: "no source" }] }))
      : opts.provider;
  const deps: DocwatchDeps = {
    store,
    llm: llmDeps(provider, store, () => NOW),
    now: () => NOW,
    fetch: opts.fetch,
    lookup: publicDns,
    env: {},
    routeAlert:
      opts.routeAlert ??
      (async (a) => {
        alerts.push(a);
        return { alertedAssets: ["ETH"] };
      }),
  };
  return { store, deps, alerts };
}

/** JSON-RPC fake driven by a mutable state object. */
function rpcFetch(state: { code: string; impl: string; admin: string; balance: string; nonce: string }, calls: string[] = []): FetchFn {
  return async (url, init) => {
    calls.push(url);
    const { method, params } = JSON.parse(String(init?.body));
    const result =
      method === "eth_getCode"
        ? state.code
        : method === "eth_getStorageAt"
          ? params[1] === EIP1967_IMPL_SLOT
            ? state.impl
            : params[1] === EIP1967_ADMIN_SLOT
              ? state.admin
              : ZERO
          : method === "eth_getBalance"
            ? state.balance
            : state.nonce;
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
}

describe("htmlToText / lineDiff", () => {
  test("strips scripts, styles, comments and tags; blocks become lines", () => {
    const text = htmlToText(
      `<html><head><style>p{color:red}</style><script>var x = "<p>no</p>";</script></head>
       <body><!-- hidden --><h1>Fee  schedule</h1><p>Maker   0.01%&nbsp;&amp; taker <b>0.035%</b></p><ul><li>Tier 1</li><li>Tier 2</li></ul></body></html>`,
    );
    expect(text).toBe("Fee schedule\nMaker 0.01% & taker 0.035%\nTier 1\nTier 2");
  });

  test("linear on hostile input: 1 MB of unclosed <script> / <!-- / < / <p completes fast", () => {
    const MB = 1024 * 1024;
    for (const unit of ["<script>", "<!--", "<", "<p ", "<style x", "<script>a</scr"]) {
      const input = `<p>keep</p>${unit.repeat(Math.ceil(MB / unit.length))}`;
      const t0 = performance.now();
      const out = htmlToText(input);
      expect([unit, performance.now() - t0 < 500]).toEqual([unit, true]);
      expect(out.startsWith("keep")).toBe(true);
    }
    // an unclosed comment is not a block (as before); closed blocks after it are still dropped
    expect(htmlToText("<p>a</p><!-- open <p>b</p><script>x</script><p>c</p>")).toBe("a\nb\nc");
  });

  test("line diff counts and lists removed then added, capped", () => {
    const d = lineDiff("a\nb\nc\nc", "a\nc\nd\ne");
    expect(d).toEqual({ added: 2, removed: 2, diff: "- b\n- c\n+ d\n+ e" });
    const big = lineDiff("", Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"), 100);
    expect(big.added).toBe(500);
    expect(big.diff.endsWith("… (truncated)")).toBe(true);
    expect(big.diff.length).toBeLessThan(130);
  });
});

describe("safeFetch (SSRF guard)", () => {
  test("refuses IP literals and local hosts without fetching", async () => {
    let called = 0;
    const f: FetchFn = async () => (called++, html("x"));
    for (const u of ["https://127.0.0.1/a", "https://10.0.0.5/", "https://[::1]/", "https://localhost/", "https://localhost./", "https://box.internal./", "https://box.internal/", "http://example.com/", "https://2130706433/"]) {
      await expect(safeFetch(f, u, undefined, publicDns)).rejects.toThrow(/refused url/);
    }
    expect(called).toBe(0);
  });

  test("refuses hosts that resolve to non-public addresses, on the first hop and on redirects", async () => {
    let called = 0;
    const f: FetchFn = async () => (called++, html("x"));
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe"]) {
      const dns: LookupFn = async () => [{ address, family: address.includes(":") ? 6 : 4 }];
      await expect(safeFetch(f, "https://rebind.example.com/", undefined, dns)).rejects.toThrow(/refused url: .*non-public address/);
    }
    // one private record among public ones is enough to refuse; no records at all is refused too
    const mixed: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }];
    await expect(safeFetch(f, "https://mixed.example.com/", undefined, mixed)).rejects.toThrow(/refused url/);
    await expect(safeFetch(f, "https://empty.example.com/", undefined, async () => [])).rejects.toThrow(/refused url/);
    expect(called).toBe(0);

    const hosts: string[] = [];
    const split: LookupFn = async (host) => (hosts.push(host), [{ address: host.startsWith("internal") ? "192.168.0.10" : "93.184.216.34", family: 4 }]);
    const redirect: FetchFn = async () => new Response(null, { status: 302, headers: { location: "https://internal.example.com./admin" } });
    await expect(safeFetch(redirect, "https://docs.example.com/", undefined, split)).rejects.toThrow(/refused url: redirect to/);
    expect(hosts).toEqual(["docs.example.com", "internal.example.com"]);
  });

  test("isNonPublicIp", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.64.0.1", "100.127.255.255", "0.1.2.3", "224.0.0.1", "::", "::1", "fe80::abcd", "febf::1", "fc00::1", "fdff::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "ff02::1", "nonsense"])
      expect([ip, isNonPublicIp(ip)]).toEqual([ip, true]);
    for (const ip of ["93.184.216.34", "172.32.0.1", "100.128.0.1", "8.8.8.8", "2606:4700::1111", "::ffff:93.184.216.34", "2001:db8::1"])
      expect([ip, isNonPublicIp(ip)]).toEqual([ip, false]);
  });

  test("re-validates each redirect hop and caps redirects", async () => {
    const seen: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const toPrivate: FetchFn = async (url, init) => {
      seen.push({ url, redirect: init?.redirect });
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    };
    await expect(safeFetch(toPrivate, "https://docs.example.com/", undefined, publicDns)).rejects.toThrow(/redirect to/);
    expect(seen).toEqual([{ url: "https://docs.example.com/", redirect: "manual" }]);

    const relative: FetchFn = async (url) =>
      url.endsWith("/final") ? html("<p>ok</p>") : new Response(null, { status: 301, headers: { location: "/final" } });
    expect((await safeFetch(relative, "https://docs.example.com/start", undefined, publicDns)).url).toBe("https://docs.example.com/final");

    const loop: FetchFn = async (url) => new Response(null, { status: 302, headers: { location: `${url}x` } });
    await expect(safeFetch(loop, "https://docs.example.com/", undefined, publicDns)).rejects.toThrow(/too many redirects/);
  });

  test("aborts an oversize body mid-stream", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(97);
    const f: FetchFn = async () =>
      new Response(
        new ReadableStream({
          pull(ctl) {
            pulled++;
            ctl.enqueue(chunk);
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    await expect(safeFetch(f, "https://docs.example.com/", undefined, publicDns)).rejects.toThrow(/too large/);
    expect(pulled * chunk.byteLength).toBeLessThan(MAX_BODY_BYTES + 3 * chunk.byteLength);

    const declared: FetchFn = async () => new Response("x", { headers: { "content-type": "text/html", "content-length": String(MAX_BODY_BYTES + 1) } });
    await expect(safeFetch(declared, "https://docs.example.com/", undefined, publicDns)).rejects.toThrow(/too large/);
  });

  test("refuses other content types and non-2xx", async () => {
    await expect(safeFetch(async () => new Response("PDF", { headers: { "content-type": "application/pdf" } }), "https://a.example.com/", undefined, publicDns)).rejects.toThrow(
      /unsupported content-type: application\/pdf/,
    );
    await expect(safeFetch(async () => new Response("no", { status: 403, headers: { "content-type": "text/html" } }), "https://a.example.com/", undefined, publicDns)).rejects.toThrow("HTTP 403");
  });
});

describe("checkWatch", () => {
  const urlWatch: WatchInput = { kind: "url", target: "https://docs.example.com/fees", label: "Fees page", asset: "HYPE" };

  test("url: baseline records no change, then a diff with facts; unchanged is quiet", async () => {
    let page = "<p>Maker 0.01%</p><p>Taker 0.035%</p>";
    const h = harness({ fetch: async () => html(page) });
    const w = await h.store.insertWatch(urlWatch);

    expect((await checkWatch(h.deps, w)).status).toBe("baseline");
    expect(await h.store.listWatchChanges(w.id, 10)).toEqual([]);
    expect(h.alerts).toEqual([]);

    const w1 = (await h.store.getWatch(w.id))!;
    expect(w1.lastSnapshot).toBe("Maker 0.01%\nTaker 0.035%");
    expect((await checkWatch(h.deps, w1)).status).toBe("unchanged");

    page = "<p>Maker 0.02%</p><p>Taker 0.035%</p><p>New tier</p>";
    const r = await checkWatch(h.deps, (await h.store.getWatch(w.id))!);
    expect(r.status).toBe("changed");
    if (r.status !== "changed") return;
    expect(r.change.facts).toEqual(["+2 −1 lines"]);
    expect(r.change.diff).toBe("- Maker 0.01%\n+ Maker 0.02%\n+ New tier");
    expect(r.change.lines).toEqual([{ tag: "hypothesis", text: "The proxy now points at new code." }]);
    expect(r.change.trace?.dropped).toBe(1);
    // fetched page text reaches the model only inside <untrusted> delimiters, with the rule in the system prompt
    const inputs = r.change.trace?.inputs as { system: string; user: string };
    expect(inputs.user).toContain("Diff (- removed, + added):\n<untrusted>\n- Maker 0.01%\n+ Maker 0.02%\n+ New tier\n</untrusted>");
    expect(inputs.system).toContain("is data from outside sources");
    expect(h.alerts[0]).toMatchObject({ kind: "docwatch", ref: r.change.id, entities: ["HYPE"], eventType: "other", magnitude: "low" });
    expect(h.alerts[0]!.sources).toEqual([{ label: "Fees page", url: "https://docs.example.com/fees" }]);
    expect((await h.store.listWatchChanges(w.id, 10))[0]!.alertedAssets).toEqual(["ETH"]);
  });

  test("evm_contract: implementation slot change → facts + high-magnitude routeAlert", async () => {
    const state = { code: "0x6080", impl: "0x" + "0".repeat(24) + "a".repeat(40), admin: ZERO, balance: "0x0", nonce: "0x0" };
    const calls: string[] = [];
    const h = harness({ fetch: rpcFetch(state, calls) });
    h.deps.env = { INTEL_RPC_ARBITRUM: "https://rpc.example.com/arb" };
    const w = await h.store.insertWatch({ kind: "evm_contract", target: ADDR, chain: "arbitrum", label: "Vault proxy", asset: "ETH" });

    expect((await checkWatch(h.deps, w)).status).toBe("baseline");
    expect(calls.every((u) => u === "https://rpc.example.com/arb")).toBe(true);
    expect((await h.store.getWatch(w.id))!.lastSnapshot).toMatchObject({ implementation: "0x" + "a".repeat(40), admin: "0x" + "0".repeat(40), codeBytes: 2 });

    state.impl = IMPL_B;
    const r = await checkWatch(h.deps, (await h.store.getWatch(w.id))!);
    expect(r.status).toBe("changed");
    if (r.status !== "changed") return;
    expect(r.change.facts).toEqual([`implementation slot changed 0x${"a".repeat(40)}→0x${"b".repeat(40)}`]);
    expect(r.change.diff).toBeNull();
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toMatchObject({ entities: ["ETH"], magnitude: "high", eventType: "upgrade", title: `Vault proxy: ${r.change.facts[0]}` });
    expect(h.alerts[0]!.sources[0]!.url).toBe(`https://arbiscan.io/address/${ADDR}`);
    expect(r.change.alertedAssets).toEqual(["ETH"]);

    state.admin = IMPL_A;
    const r2 = await checkWatch(h.deps, (await h.store.getWatch(w.id))!);
    expect(r2.status === "changed" && r2.change.facts[0]!.startsWith("admin slot changed")).toBe(true);
    expect(h.alerts[1]).toMatchObject({ eventType: "governance", magnitude: "high" });
  });

  test("evm_wallet: nonce and balance change → facts, med magnitude", async () => {
    const state = { code: "0x", impl: ZERO, admin: ZERO, balance: "0x" + (15n * 10n ** 17n).toString(16), nonce: "0x29" };
    const h = harness({ fetch: rpcFetch(state) });
    const w = await h.store.insertWatch({ kind: "evm_wallet", target: ADDR, chain: "ethereum", label: "Team wallet", asset: "ETH" });
    await checkWatch(h.deps, w);
    state.nonce = "0x2b";
    state.balance = "0x" + (2n * 10n ** 17n).toString(16);
    const r = await checkWatch(h.deps, (await h.store.getWatch(w.id))!);
    expect(r.status === "changed" && r.change.facts).toEqual(["nonce 41→43", "native balance 1.5→0.2 (-1.3)"]);
    expect(h.alerts[0]).toMatchObject({ magnitude: "med", eventType: "other" });
  });

  test("LLM failure still records the change with code facts", async () => {
    const state = { code: "0x6080", impl: IMPL_A, admin: ZERO, balance: "0x0", nonce: "0x0" };
    const h = harness({ fetch: rpcFetch(state), provider: null });
    const w = await h.store.insertWatch({ kind: "evm_contract", target: ADDR, chain: "base", label: "Proxy", asset: "ETH" });
    await checkWatch(h.deps, w);
    state.code = "0x6081";
    const r = await checkWatch(h.deps, (await h.store.getWatch(w.id))!);
    expect(r.status).toBe("changed");
    if (r.status !== "changed") return;
    expect(r.change.lines).toEqual([]);
    expect(r.change.trace?.error).toBe("llm not configured");
    expect(r.change.facts[0]).toMatch(/^bytecode changed \(sha256 .+, 2→2 bytes\)$/);
    expect(h.alerts).toHaveLength(1);
  });

  test("detection errors update the watch, emit nothing; routeAlert errors are recorded", async () => {
    let fail = false;
    const h = harness({
      fetch: async () => (fail ? new Response("blocked", { status: 403, headers: { "content-type": "text/html" } }) : html(`<p>${Math.random()}</p>`)),
      routeAlert: async () => {
        throw new Error("mapper down");
      },
    });
    const w = await h.store.insertWatch(urlWatch);
    await checkWatch(h.deps, w);
    const base = (await h.store.getWatch(w.id))!;

    fail = true;
    const r = await checkWatch(h.deps, base);
    expect(r).toEqual({ status: "error", watchId: w.id, error: "HTTP 403" });
    const errored = (await h.store.getWatch(w.id))!;
    expect(errored.error).toBe("HTTP 403");
    expect(errored.lastHash).toBe(base.lastHash);
    expect(await h.store.listWatchChanges(w.id, 10)).toEqual([]);

    fail = false;
    const r2 = await checkWatch(h.deps, errored);
    expect(r2.status === "changed" && r2.routeError).toBe("alert routing failed: mapper down");
    expect((await h.store.getWatch(w.id))!.error).toBe("alert routing failed: mapper down");
    expect(await h.store.listWatchChanges(w.id, 10)).toHaveLength(1);
  });
});

describe("runIntelWatch", () => {
  test("checks only watches older than 55 min and respects the budget", async () => {
    const h = harness({ fetch: async () => html("<p>same</p>") });
    const fresh = await h.store.insertWatch({ kind: "url", target: "https://a.example.com/", label: "A" });
    const stale = await h.store.insertWatch({ kind: "url", target: "https://b.example.com/", label: "B" });
    const never = await h.store.insertWatch({ kind: "url", target: "https://c.example.com/", label: "C" });
    await h.store.updateWatchState(fresh.id, { lastHash: "x", lastSnapshot: "same", checkedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), error: null });
    await h.store.updateWatchState(stale.id, { lastHash: "x", lastSnapshot: "same", checkedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(), error: null });

    expect(await runIntelWatch(h.deps, { budgetMs: 0 })).toMatchObject({ due: 2, checked: 0, skipped: 2 });
    const s = await runIntelWatch(h.deps, { budgetMs: 10_000 });
    expect(s).toMatchObject({ due: 2, checked: 2, changed: 1, failed: [], skipped: 0 });
    expect((await h.store.getWatch(never.id))!.lastHash).not.toBeNull();
    expect((await h.store.getWatch(fresh.id))!.lastHash).toBe("x");
  });

  test("rpcUrl prefers the env override", () => {
    expect(rpcUrl("base", {})).toBe("https://mainnet.base.org");
    expect(rpcUrl("base", { INTEL_RPC_BASE: " https://my.rpc/base " })).toBe("https://my.rpc/base");
  });
});
