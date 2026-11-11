import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Rule, StudyResult } from "../lib/lab";
import { catalogueIdIn, concreteRule, exitsForm, parseExitParams, parseRuleParam, realCoin, ruleDrillHref, studyArgs, studyHref, studyRoute } from "../lib/study";
import { boardStudy, UNIVERSE_ASSET, type DefinitionsResponse, type SetupReplayResponse } from "../../shared/research";
import { SetupReplayView, type SetupReplayViewProps } from "../components/lab/SetupReplay";
import { StudyView, type StudyViewProps } from "./LabStudy";

// Render-checks (react-dom/server, no jsdom), the cockpit render.test.tsx approach:
// the ?rule= contract and each study state the brief pins.

const rule: Rule = { asset: "BTC", direction: "long", horizonDays: 14, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1.5 }] };
const noop = () => {};
const screen = (weeks: number, expectancy: number | null, upper95: number | null) => ({ events: weeks + 4, weeks, expectancy, upper95 });

const result = (verdict: StudyResult["verdict"], over: Partial<StudyResult> = {}): StudyResult => ({
  text: "ht:funding|z|30 < -1.5",
  direction: "long",
  horizonDays: 14,
  stopAtr: 1.5,
  targetAtr: 3,
  slippageBps: 5,
  feeRoundTripPct: 0.09,
  period: { from: "2023-01-01", to: "2026-11-08", holdoutFrom: "2025-09-01" },
  screen: screen(42, 0.12, 0.31),
  verdict,
  train: screen(30, 0.1, 0.4),
  holdout: screen(12, 0.2, 0.6),
  funnel: { steps: [{ condition: "ht:funding z(30) < -1.5", survivors: 812, dropRel: 0.93 }], bottleneck: 0 },
  coins: [
    { coin: "BTC", bars: 900, from: "2023-01-01", to: "2026-11-08", events: 20, status: "ok" },
    { coin: "NEWCOIN", bars: 0, from: null, to: null, events: 0, status: "insufficient", reason: "only 120 bars" },
  ],
  eventList: Array.from({ length: 200 }, (_, i) => ({ coin: "BTC", date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`, exit: "target" as const, exitDate: "2024-02-01", r: i % 2 ? 1.2 : -1, fundingR: -0.01, ambiguous: false })).map((e, i) => ({ ...e, coin: `C${i}` })),
  eventListTotal: 1234,
  survivorship: "Survivorship: the replay uses today's listed coins.",
  warnings: [],
  idea: { n: 7, of: 93 },
  catalogueId: null,
  ...over,
});

const props = (over: Partial<StudyViewProps> = {}): StudyViewProps => ({
  parsedError: null,
  rule,
  coin: "BTC",
  universe: { kind: "top", n: 20 },
  onUniverse: noop,
  exits: { applied: { stopAtr: 1.5, targetAtr: 3 }, draft: { stop: "1.5", target: "3" }, onDraft: noop, onRun: noop },
  study: { data: null, loading: false, error: null, offline: false, refetch: noop },
  definitions: { data: null, loading: false, error: null, offline: false, refetch: noop },
  pickerOpen: false,
  onPicker: noop,
  metrics: [],
  ...over,
});
const render = (p: StudyViewProps) => renderToStaticMarkup(<MemoryRouter><StudyView {...p} /></MemoryRouter>);

describe("?rule= param", () => {
  test("good JSON parses to the rule", () => {
    expect(parseRuleParam(JSON.stringify(rule))).toEqual({ rule, error: null });
  });
  test("missing → no rule, no error", () => {
    expect(parseRuleParam(null)).toEqual({ rule: null, error: null });
    expect(parseRuleParam("")).toEqual({ rule: null, error: null });
  });
  test("bad JSON or bad shape → error", () => {
    expect(parseRuleParam("{nope")).toEqual({ rule: null, error: "rule: not valid JSON" });
    const bad = parseRuleParam(JSON.stringify({ ...rule, horizonDays: 999 }));
    expect(bad.rule).toBeNull();
    expect(bad.error).toContain("rule.horizonDays");
  });
  test("studyHref round trip, with and without coin", () => {
    const u = new URL(studyHref(rule, "kPEPE"), "http://x");
    expect(u.pathname).toBe("/lab/study");
    expect(parseRuleParam(u.searchParams.get("rule")).rule).toEqual(rule);
    expect(u.searchParams.get("coin")).toBe("kPEPE");
    expect(new URL(studyHref(rule), "http://x").searchParams.has("coin")).toBe(false);
    expect(studyHref(rule)).toBe(`/lab/study?rule=${encodeURIComponent(JSON.stringify(rule))}`);
  });
  test("OPEN RULE href carries the rule to the drill and back", () => {
    const u = new URL(ruleDrillHref(rule, "SOL"), "http://x");
    expect(u.pathname).toBe("/lab/rules/study");
    expect(parseRuleParam(u.searchParams.get("rule")).rule).toEqual(rule);
    expect(u.searchParams.get("coin")).toBe("SOL");
    expect(u.searchParams.get("from")).toBe("study");
  });
  test("universe → tool args", () => {
    expect(studyArgs(rule, "SOL", { kind: "coin" })).toMatchObject({ coins: ["SOL"], stopAtr: 1.5, targetAtr: 3 });
    expect(studyArgs(rule, "SOL", { kind: "top", n: 10 })).toMatchObject({ top: 10 });
    expect(studyArgs(rule, "SOL", { kind: "mine" })).toMatchObject({ mine: true });
    expect(studyArgs(rule, "SOL", { kind: "mine" })).not.toHaveProperty("coins");
  });
  test("canonical studies go through the board's cache, with the exact body the board keys evidence on", () => {
    expect(studyRoute(rule, "SOL", { kind: "coin" })).toEqual({ kind: "board", body: boardStudy({ rule, coin: "SOL", scope: "coin" })! });
    expect(studyRoute(rule, "SOL", { kind: "top", n: 20 })).toEqual({ kind: "board", body: boardStudy({ rule, coin: "SOL", scope: "universe" })! });
    expect(studyRoute(rule, "SOL", { kind: "top", n: 10 })).toEqual({ kind: "lab", args: studyArgs(rule, "SOL", { kind: "top", n: 10 }) });
    expect(studyRoute(rule, "SOL", { kind: "mine" })).toEqual({ kind: "lab", args: studyArgs(rule, "SOL", { kind: "mine" }) });
    // A coin the study route does not accept (HIP-3 `dex:SYM`) stays on the Lab tool.
    expect(studyRoute(rule, "xyz:SKHX", { kind: "coin" }).kind).toBe("lab");
  });
});

describe("stop/target", () => {
  const defaults = { stopAtr: 1.5, targetAtr: 3 };
  test("URL round trip: ?stop=&target= only off the defaults; bad or missing values read as the defaults", () => {
    const href = studyHref(rule, "SOL", { stopAtr: 2, targetAtr: 4.5 });
    const u = new URL(href, "http://x");
    expect(parseExitParams(u.searchParams.get("stop"), u.searchParams.get("target"))).toEqual({ stopAtr: 2, targetAtr: 4.5 });
    expect(parseRuleParam(u.searchParams.get("rule")).rule).toEqual(rule);
    expect(studyHref(rule, "SOL", defaults)).toBe(studyHref(rule, "SOL"));
    expect(new URL(studyHref(rule, null, { stopAtr: 1.5, targetAtr: 6 }), "http://x").searchParams.has("stop")).toBe(false);
    expect(parseExitParams(null, null)).toEqual(defaults);
    expect(parseExitParams("abc", "0")).toEqual(defaults);
    expect(parseExitParams("21", "50.1")).toEqual(defaults); // past the route's bounds
    expect(parseExitParams("1.04", "2.96")).toEqual({ stopAtr: 1, targetAtr: 3 }); // 0.1 ATR, as the server keys it
    expect(new URL(ruleDrillHref(rule, "SOL", { stopAtr: 2, targetAtr: 3 }), "http://x").searchParams.get("stop")).toBe("2");
  });

  test("canonical universes go through the board route with any exits; others carry them to the Lab tool", () => {
    const e = { stopAtr: 2, targetAtr: 5 };
    expect(studyRoute(rule, "SOL", { kind: "coin" }, e)).toEqual({ kind: "board", body: { rule, coin: "SOL", ...e } });
    expect(studyRoute(rule, "SOL", { kind: "top", n: 20 }, e)).toEqual({ kind: "board", body: { rule, ...e } });
    expect(studyRoute(rule, "SOL", { kind: "top", n: 10 }, e)).toEqual({ kind: "lab", args: { rule, top: 10, ...e } });
    expect(studyRoute(rule, "SOL", { kind: "mine" }, e)).toEqual({ kind: "lab", args: { rule, mine: true, ...e } });
  });

  test("RUN is required after an edit: the draft never changes what runs until RUN", () => {
    const applied = { stopAtr: 1.5, targetAtr: 3 };
    expect(exitsForm({ stop: "1.5", target: "3" }, applied)).toEqual({ exits: applied, dirty: false, canRun: false, error: null });
    const edited = exitsForm({ stop: "2", target: "3" }, applied);
    expect(edited).toEqual({ exits: { stopAtr: 2, targetAtr: 3 }, dirty: true, canRun: true, error: null });
    // What runs is keyed on the applied exits only, so the edit alone starts no study.
    expect(studyRoute(rule, "SOL", { kind: "coin" }, applied)).toEqual(studyRoute(rule, "SOL", { kind: "coin" }));
    expect(exitsForm({ stop: "1.50", target: "3.0" }, applied).canRun).toBe(false); // same study once rounded
    expect(exitsForm({ stop: "", target: "3" }, applied)).toMatchObject({ exits: null, canRun: false, error: "STOP: 0.1–20 ATR" });
    expect(exitsForm({ stop: "2", target: "99" }, applied)).toMatchObject({ canRun: false, error: "TARGET: 0.1–50 ATR" });
  });

  test("render: labelled STOP / TARGET inputs (step 0.1, the route's bounds); RUN disabled until an edit", () => {
    const clean = render(props());
    expect(clean).toContain("STOP");
    expect(clean).toContain("TARGET");
    expect(clean).toMatch(/step="0.1" min="0.1" max="20"[^>]*value="1.5"/);
    expect(clean).toMatch(/max="50"[^>]*value="3"/);
    expect(clean).toMatch(/<button[^>]*disabled=""[^>]*>RUN</);
    const dirty = render(props({ exits: { applied: { stopAtr: 1.5, targetAtr: 3 }, draft: { stop: "2", target: "3" }, onDraft: noop, onRun: noop } }));
    expect(dirty).not.toMatch(/<button[^>]*disabled=""[^>]*>RUN</);
    expect(dirty).toContain("RUN to study with these exits");
  });
});

describe("already catalogued", () => {
  const ok = (catalogueId: string | null) => props({ study: { data: result("clear", { catalogueId }), loading: false, error: null, offline: false, refetch: noop } });
  test("catalogued: IN CATALOGUE → links to the entry; no SAVE", () => {
    const html = render(ok("abc123"));
    expect(html).toContain('href="/lab/rules/abc123"');
    expect(html).toContain("IN CATALOGUE →");
    expect(html).not.toContain(">SAVE<");
  });
  test("not catalogued: SAVE, no link", () => {
    const html = render(ok(null));
    expect(html).toContain(">SAVE<");
    expect(html).not.toContain("IN CATALOGUE");
  });
  test("the ad-hoc drill: the evaluation id (the rule hash) found in the catalogue list", () => {
    expect(catalogueIdIn("h1", [{ id: "h0" }, { id: "h1" }])).toBe("h1");
    expect(catalogueIdIn("h2", [{ id: "h1" }])).toBeNull();
    expect(catalogueIdIn(undefined, [{ id: "h1" }])).toBeNull();
    expect(catalogueIdIn("h1", null)).toBeNull();
  });
});

describe("StudyView states", () => {
  test("empty: no rule → links to SEARCH and CATALOGUE", () => {
    const html = render(props({ rule: null }));
    expect(html).toContain("no rule to study");
    expect(html).toContain(">SEARCH<");
    expect(html).toContain(">CATALOGUE<");
    expect(html).not.toContain('role="alert"');
  });
  test("bad rule: ErrorBlock plus the empty state", () => {
    const html = render(props({ rule: null, parsedError: "rule: not valid JSON" }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("rule: not valid JSON");
    expect(html).toContain("no rule to study");
  });
  test("running: rule header, busy line, skeleton", () => {
    const html = render(props({ study: { data: null, loading: true, error: null, offline: false, refetch: noop } }));
    expect(html).toContain("RUNNING STUDY…");
    expect(html).toContain("OPEN RULE");
    expect(html).toContain("UNIVERSE");
    expect(html).toContain("pulse-label");
  });
  test("error: server message verbatim with RETRY", () => {
    const html = render(props({ study: { data: null, loading: false, error: "the universe has 40 coins; at most 20 without a database: lower top", offline: false, refetch: noop } }));
    expect(html).toContain("at most 20 without a database");
    expect(html).toContain("RETRY");
  });
  for (const [verdict, word, tone] of [
    ["clear", "CLEAR", "text-green"],
    ["rejected", "REJECTED", "text-red-text"],
    ["insufficient", "INSUFFICIENT", "text-text-secondary"],
  ] as const) {
    test(`result: ${verdict} verdict, text plus colour, in the brief's order`, () => {
      const html = render(props({ study: { data: result(verdict), loading: false, error: null, offline: false, refetch: noop } }));
      expect(html).toMatch(new RegExp(`${tone}[^"]*"[^>]*>${word}<`));
      expect(html).toContain("46 events · 42 weeks · expectancy +0.12R · upper95 +0.31R");
      expect(html).toContain("200 of 1,234");
      expect(html).toContain("idea 7 of 93");
      expect(html).toContain("BOTTLENECK");
      const order = ["VERDICT", "TRAIN VS HOLDOUT", "CONDITION FUNNEL", "PER COIN", "panel-title\">EVENTS<", "Survivorship", "idea 7 of 93"].map((s) => html.indexOf(s));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
  }
});

// Signals v2: a definition's rule has the placeholder asset UNIVERSE_ASSET. It is a universe study, never a coin.
describe("placeholder asset", () => {
  const defRule: Rule = { ...rule, asset: UNIVERSE_ASSET, direction: "short", horizonDays: 7 };
  const done = { data: result("clear"), loading: false, error: null, offline: false, refetch: noop };

  test("realCoin / concreteRule: the placeholder is no coin; it takes `?coin=` when that is a ticker", () => {
    expect(realCoin(UNIVERSE_ASSET)).toBe("");
    expect(realCoin(null)).toBe("");
    expect(realCoin("SOL")).toBe("SOL");
    expect(concreteRule(rule, null)).toBe(rule);
    expect(concreteRule(defRule, null)).toBeNull();
    expect(concreteRule(defRule, UNIVERSE_ASSET)).toBeNull();
    expect(concreteRule(defRule, "xyz:SKHX")).toBeNull();
    expect(concreteRule(defRule, "SOL")).toEqual({ ...defRule, asset: "SOL" });
  });
  test("studyHref never writes ?coin=UNIVERSE; studyRoute never sends it", () => {
    expect(studyHref(defRule, UNIVERSE_ASSET)).toBe(studyHref(defRule));
    expect(studyHref(defRule)).not.toContain("coin=");
    // "this coin" with no real coin is the default universe, and the body carries no coin.
    expect(studyRoute(defRule, UNIVERSE_ASSET, { kind: "coin" })).toEqual({ kind: "board", body: boardStudy({ rule: defRule, coin: "X", scope: "universe" })! });
    expect(studyRoute(defRule, "", { kind: "coin" })).toEqual(studyRoute(defRule, "", { kind: "top", n: 20 }));
    expect(studyRoute(defRule, "SOL", { kind: "coin" })).toEqual({ kind: "board", body: { rule: defRule, coin: "SOL", stopAtr: 1.5, targetAtr: 3 } });
  });
  test("render without ?coin=: no THIS COIN option, no UNIVERSE as a coin; OPEN RULE and SAVE disabled with the reason", () => {
    const html = render(props({ rule: defRule, coin: "", study: done }));
    expect(html).not.toContain("THIS COIN");
    expect(html).not.toContain("/asset/UNIVERSE");
    expect(html).toContain("TOP 20");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>OPEN RULE</);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>SAVE</);
    expect(html).toContain("a universe definition has no coin of its own");
    expect(html).not.toMatch(/COIN · UNIVERSE|coin=UNIVERSE/);
  });
  test("render with ?coin=: THIS COIN is offered for that coin and OPEN RULE and SAVE are enabled", () => {
    const html = render(props({ rule: defRule, coin: "SOL", coinParam: "SOL", universe: { kind: "coin" }, study: done }));
    expect(html).toContain("THIS COIN · SOL");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>OPEN RULE</);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>SAVE</);
    expect(html).not.toContain("a universe definition has no coin of its own");
    expect(new URL(ruleDrillHref(concreteRule(defRule, "SOL")!, "SOL"), "http://x").searchParams.get("rule")).toContain('"asset":"SOL"');
  });
  test("an ordinary rule keeps THIS COIN for its own asset", () => {
    expect(render(props())).toContain("THIS COIN · BTC");
  });
});

describe("DEFINITIONS picker", () => {
  const defs: DefinitionsResponse = {
    definitions: [
      { id: "funding_fade", name: "Funding fade", thesis: "crowded longs pay funding and mean-revert", rule: { ...rule, asset: UNIVERSE_ASSET, direction: "short", horizonDays: 7 }, ruleText: "funding z(90) ≥ 2 → short 7d", intradayKinds: ["crowded_long"] },
      { id: "range_breakout", name: "Range breakout", thesis: "a 20-day high on volume", rule: { ...rule, asset: UNIVERSE_ASSET, horizonDays: 7 }, ruleText: "price pctile(20) ≥ 1 → long 7d", intradayKinds: [] },
    ],
  };
  const state = (over: Partial<StudyViewProps["definitions"]> = {}) => ({ data: null, loading: false, error: null, offline: false, refetch: noop, ...over });

  test("empty state lists each definition: name, thesis, rule text; each links its prefilled universe study", () => {
    const html = render(props({ rule: null, definitions: state({ data: defs }) }));
    expect(html).toContain("DEFINITIONS");
    expect(html).toContain("Funding fade");
    expect(html).toContain("crowded longs pay funding and mean-revert");
    expect(html).toContain("funding z(90) ≥ 2 → short 7d");
    expect(html).toContain("Range breakout");
    const href = studyHref(defs.definitions[0]!.rule).replace(/&/g, "&amp;");
    expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain("coin=");
    expect(html).not.toContain("no rule to study — open");
  });
  test("ladder: loading skeleton, error with RETRY, empty list", () => {
    expect(render(props({ rule: null, definitions: state({ loading: true }) }))).toContain("pulse-label");
    const err = render(props({ rule: null, definitions: state({ error: "definitions exploded" }) }));
    expect(err).toContain("definitions exploded");
    expect(err).toContain("RETRY");
    expect(render(props({ rule: null, definitions: state({ data: { definitions: [] } }) }))).toContain("no definitions shipped");
  });
  test("with a rule loaded: a DEFINITIONS control opens the picker; closed, the list is not rendered", () => {
    const closed = render(props({ definitions: state({ data: defs }) }));
    expect(closed).toMatch(/<button[^>]*aria-expanded="false"[^>]*>DEFINITIONS</);
    expect(closed).not.toContain("Funding fade");
    const open = render(props({ pickerOpen: true, definitions: state({ data: defs }) }));
    expect(open).toMatch(/<button[^>]*aria-expanded="true"[^>]*>DEFINITIONS</);
    expect(open).toContain("Funding fade");
  });
});

describe("INTRADAY SETUPS · REPLAY", () => {
  const poll = (data: SetupReplayResponse | null, over: Partial<SetupReplayViewProps["replay"]> = {}): SetupReplayViewProps["replay"] => ({ data, loading: false, error: null, offline: false, refetch: noop, ...over });
  const base: SetupReplayResponse = {
    state: "ok", asOf: "2026-11-11T10:00:00Z", source: "candles", window: { from: "2026-09-20T00:00:00Z", to: "2026-11-11T09:45:00Z" }, coins: ["BTC", "ETH", "SOL"], grid: "15m", horizons: ["1h", "24h"], assumptions: ["slippage 0: understated for thin coins"],
    setups: [
      { kind: "vol_expansion_breakout", side: "long", horizon: "24h", evaluable: true, entries: 31, n: 29, clusters: 12, meanNet: 0.0042, ci95: [-0.001, 0.0095], hitRate: 0.55 },
      { kind: "vol_expansion_breakout", side: "short", horizon: "24h", evaluable: true, entries: 9, n: 8, clusters: 3, meanNet: -0.0021, ci95: null, hitRate: 0.375 },
      { kind: "crowded_long", side: "short", horizon: "24h", evaluable: false, reason: "reads oiChg1hZ: no open-interest stream", entries: 0, n: 0, clusters: 0, meanNet: null, ci95: null, hitRate: null },
      { kind: "vol_expansion_breakout", side: "long", horizon: "1h", evaluable: true, entries: 31, n: 0, clusters: 0, meanNet: null, ci95: null, hitRate: null },
    ],
  };
  const defs: DefinitionsResponse = { definitions: [{ id: "range_breakout", name: "Range breakout", thesis: "t", rule: { ...rule, asset: UNIVERSE_ASSET, direction: "long" }, ruleText: "x", intradayKinds: ["vol_expansion_breakout"] }] };
  const view = (replay: SetupReplayViewProps["replay"], horizon: string | null = null, d: DefinitionsResponse | null = defs) =>
    renderToStaticMarkup(<MemoryRouter><SetupReplayView replay={replay} definitions={d} horizon={horizon} onHorizon={noop} /></MemoryRouter>);

  test("ok: default 24h rows with n, clusters, mean net and its interval, hit; the not-a-trial label; footnote", () => {
    const html = view(poll(base));
    expect(html).toContain("INTRADAY SETUPS · REPLAY");
    expect(html).toContain("not a trial");
    expect(html).toContain("vol expansion breakout");
    expect(html).toContain("+0.42%");
    expect(html).toContain("[−0.10%, +0.95%]");
    expect(html).toContain("55%");
    expect(html).toContain("2026-09-20 → 2026-11-11");
    expect(html).toContain("3 coins");
    expect(html).toContain("15m grid");
    expect(html).toContain("slippage 0: understated for thin coins");
    expect(html).toContain('aria-checked="true"');
  });
  test("under the cluster minimum: the interval is an em dash with its reason, the mean stays", () => {
    const html = view(poll(base));
    expect(html).toContain("interval needs 5+ clusters (has 3)");
    expect(html).toContain("−0.21%");
  });
  test("a not-evaluable row is dimmed with its reason and shows no numbers or zeros", () => {
    const html = view(poll(base));
    const li = html.split("<li").find((x) => x.includes("crowded long"))!;
    expect(li).toContain("opacity-60");
    expect(li).toContain("not evaluable");
    expect(li).toContain("reads oiChg1hZ: no open-interest stream");
    expect(li).not.toContain("ENTRIES");
    expect(li).not.toContain(">0<");
  });
  test("n 0 at the horizon: em dashes and why, never 0%", () => {
    const html = view(poll(base), "1h");
    expect(html).toContain("31 entries, none graded at 1h");
    expect(html).not.toContain("0.00%");
    expect(html).not.toContain("HIT </span>0%");
  });
  test("a horizon the response lacks falls back to the default", () => {
    expect(view(poll(base), "72h")).toContain("+0.42%");
  });
  test("links a kind to its daily definition on the same side only", () => {
    const html = view(poll(base));
    expect(html.match(/daily: Range breakout/g)).toHaveLength(1);
    expect(html).toContain("/lab/study?rule=");
    expect(view(poll(base), null, null)).not.toContain("daily: ");
  });
  test("pending: says so, with the cadence, no rows", () => {
    const html = view(poll({ ...base, state: "pending", window: null, coins: [], setups: [], horizons: [], assumptions: [] }));
    expect(html).toContain("REPLAY RUNNING");
    expect(html).toContain("4–5 minutes");
    expect(html).not.toContain("not evaluable");
  });
  test("unavailable: the server's reason", () => {
    const html = view(poll({ ...base, state: "unavailable", reason: "history too sparse for the snapshots source", window: null, coins: [], setups: [], horizons: [], assumptions: [] }));
    expect(html).toContain("unavailable");
    expect(html).toContain("history too sparse for the snapshots source");
  });
  test("first load is a skeleton, a failure the server string with retry", () => {
    expect(view(poll(null, { loading: true }))).toContain("pulse-label");
    expect(view(poll(null, { error: "replay exploded" }))).toContain("replay exploded");
  });
  test("the study page mounts the block under the picker, with and without a rule", () => {
    expect(render(props({ rule: null }))).toContain("INTRADAY SETUPS · REPLAY");
    expect(render(props())).toContain("INTRADAY SETUPS · REPLAY");
  });
});
