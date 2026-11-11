import { describe, expect, test } from "bun:test";
import type { RadarCall } from "../../shared/radar";
import type { Rule } from "./lab";
import { boardStudy, STUDY_DEFAULTS, UNIVERSE_ASSET, type LedgerEvidence, type SetupReplayRow } from "../../shared/research";
import { ApiError } from "./api";
import { authOf, cellState, dailyState, ledgerText, noEvidenceText, rowStudyKey, runState, scopeLabel, scorecardText, studyFailed, testedLabel } from "./research";
import { defaultReplayHorizon, definitionForKind, kindLabel, replayFacts, replayRowsAt } from "./research";
import { boardHref, boardKey, flatSignals, recentCalls, rootRedirect, signalBlocks, signalStudyHref, type BoardSignal } from "./research";

const rule: Rule = { asset: "BTC", direction: "long", horizonDays: 5, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1 }] };
const sig = (id: string, coin: string, at: number, over: Partial<BoardSignal> = {}): BoardSignal => ({
  id, source: "rule", coin, direction: null, tested: null, scope: "coin", headline: "", at, rule: null, ruleText: null, href: null, evidence: null, dailyStudy: null, definitionId: null, ...over,
});

describe("signalBlocks", () => {
  const list = [sig("a", "ETH", 1), sig("b", "BTC", 5), sig("c", "ETH", 9), sig("d", "SOL", 3)];
  test("newest first; a coin with several signals is grouped at its newest, rows newest first", () => {
    const blocks = signalBlocks(list);
    expect(blocks.map((b) => [b.coin, b.grouped, b.signals.map((s) => s.id)])).toEqual([
      ["ETH", true, ["c", "a"]],
      ["BTC", false, ["b"]],
      ["SOL", false, ["d"]],
    ]);
    expect(flatSignals(blocks).map((s) => s.id)).toEqual(["c", "a", "b", "d"]);
  });
  test("?coin= filters case-insensitively; blank is no filter; the input is not mutated", () => {
    expect(signalBlocks(list, "eth").flatMap((b) => b.signals.map((s) => s.id))).toEqual(["c", "a"]);
    expect(signalBlocks(list, " ")).toHaveLength(3);
    expect(signalBlocks(list, "DOGE")).toEqual([]);
    expect(list.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("rootRedirect: old `/` queries", () => {
  test("review=1 → the Terminal review; any Cockpit param → /feed with the query intact", () => {
    expect(rootRedirect("?review=1")).toBe("/terminal?review=1");
    expect(rootRedirect("?id=abc")).toBe("/feed?id=abc");
    expect(rootRedirect("?status=ready&tier=2")).toBe("/feed?status=ready&tier=2");
    expect(rootRedirect("?liq=ETH&liqh=6&coin=ETH")).toBe("/feed?liq=ETH&liqh=6&coin=ETH");
  });
  test("an old board link (?coin=) goes to /board with the query; no legacy query lands on /queue", () => {
    expect(rootRedirect("?coin=ETH")).toBe("/board?coin=ETH");
    expect(rootRedirect("?coin=xyz%3ASKHX")).toBe("/board?coin=xyz%3ASKHX");
    expect(rootRedirect("")).toBe("/queue");
    expect(rootRedirect("?review=0")).toBe("/queue");
  });
});

describe("links and scope", () => {
  test("study on the coin unless the scope is the universe; no rule, no link", () => {
    expect(boardStudy(sig("a", "ETH", 1, { rule }))).toEqual({ rule, coin: "ETH", ...STUDY_DEFAULTS });
    expect(boardStudy(sig("a", "ETH", 1, { rule, scope: "universe" }))).toEqual({ rule, ...STUDY_DEFAULTS });
    expect(signalStudyHref(sig("a", "ETH", 1, { rule }))).toBe(`/lab/study?rule=${encodeURIComponent(JSON.stringify(rule))}&coin=ETH`);
    expect(signalStudyHref(sig("a", "ETH", 1, { rule, scope: "universe" }))).toBe(`/lab/study?rule=${encodeURIComponent(JSON.stringify(rule))}`);
    expect(signalStudyHref(sig("a", "ETH", 1))).toBeNull();
    expect(boardHref("xyz:SKHX")).toBe("/board?coin=xyz%3ASKHX");
    // A definition's rule is studied over the universe: the link carries no coin, and never the placeholder.
    const def = { ...rule, asset: UNIVERSE_ASSET };
    expect(signalStudyHref(sig("d", "SOL", 1, { rule: def, scope: "universe" }))).toBe(`/lab/study?rule=${encodeURIComponent(JSON.stringify(def))}`);
    expect(signalStudyHref(sig("d", "SOL", 1, { rule: def, scope: "coin" }))).toContain("&coin=SOL");
  });
});

test("boardKey: j/k/Enter/s; nothing while typing, in a dialog or with a modifier", () => {
  expect(["j", "k", "Enter", "s", "x"].map((key) => boardKey({ key, dialogOpen: false }))).toEqual(["next", "prev", "open", "study", null]);
  expect(boardKey({ key: "j", target: "input", dialogOpen: false })).toBeNull();
  expect(boardKey({ key: "j", editable: true, dialogOpen: false })).toBeNull();
  expect(boardKey({ key: "j", dialogOpen: true })).toBeNull();
  expect(boardKey({ key: "s", metaKey: true, dialogOpen: false })).toBeNull();
});

test("recentCalls: newest first, capped", () => {
  const c = (id: string, date: string) => ({ id, date, at: `${date}T08:00:00Z` }) as RadarCall;
  expect(recentCalls([c("a", "2026-11-01"), c("b", "2026-11-08"), c("c", "2026-11-05")], 2).map((x) => x.id)).toEqual(["b", "c"]);
});

describe("auth and the evidence cell", () => {
  const ev = { verdict: "clear" as const, events: 1, weeks: 1, expectancy: 0.1, upper95: 0.2, holdoutExpectancy: null, idea: null, asOf: "2026-11-09T00:00:00Z" };
  const user = { state: "user" as const };
  test("authOf: guest gating from /auth/me; a failed probe is an error, not a load", () => {
    expect(authOf({ data: { guest: true }, error: null, offline: false })).toEqual({ state: "guest" });
    expect(authOf({ data: { guest: false }, error: null, offline: false })).toEqual({ state: "user" });
    expect(authOf({ data: {}, error: null, offline: false })).toEqual({ state: "user" });
    expect(authOf({ data: null, error: "boom", offline: false })).toEqual({ state: "error", message: "boom" });
    expect(authOf({ data: null, error: null, offline: true })).toEqual({ state: "error", message: "api unreachable" });
    expect(authOf({ data: null, error: null, offline: false })).toEqual({ state: "loading" });
  });
  test("cellState: idle → running → evidence | error | sign-in; guests never get STUDY", () => {
    const s = { rule, evidence: null, source: "rule" as const };
    expect(cellState(s, undefined, user)).toEqual({ kind: "idle", error: null });
    expect(cellState(s, { state: "running" }, user)).toEqual({ kind: "running" });
    expect(cellState(s, { state: "done", summary: ev }, user)).toEqual({ kind: "evidence", summary: ev });
    expect(cellState(s, { state: "error", message: "502" }, user)).toEqual({ kind: "idle", error: "502" });
    expect(cellState(s, { state: "sign-in" }, user)).toEqual({ kind: "sign-in" });
    expect(cellState(s, undefined, { state: "guest" })).toEqual({ kind: "sign-in" });
    expect(cellState(s, undefined, { state: "loading" })).toEqual({ kind: "auth-loading" });
    expect(cellState(s, undefined, { state: "error", message: "x" })).toEqual({ kind: "auth-error", message: "x" });
    const study = { ...ev, kind: "study" as const };
    expect(cellState({ ...s, evidence: study }, undefined, { state: "guest" })).toEqual({ kind: "evidence", summary: study });
    expect(cellState({ rule: null, evidence: null, source: "rule" }, undefined, user)).toEqual({ kind: "none", source: "rule" });
  });
  test("cellState by evidence kind: ledger and scorecard are shown as they are, never as a study; a setup or call is never offered a plain STUDY", () => {
    const ledger: LedgerEvidence = { kind: "ledger", setupKind: "crowded_long", horizon: "24h", n: 3, clusters: 2, meanNet: null, ci95: null, hitRate: null };
    const card = { kind: "scorecard" as const, stance: "ride" as const, horizonDays: 7, n: 3, meanPct: 1, hitRate: 0.5 };
    expect(cellState({ rule, source: "opportunity", evidence: ledger }, undefined, user)).toEqual({ kind: "ledger", evidence: ledger });
    expect(cellState({ rule: null, source: "radar", evidence: card }, undefined, user)).toEqual({ kind: "scorecard", evidence: card });
    expect(cellState({ rule, source: "opportunity", evidence: null }, { state: "done", summary: ev }, user)).toEqual({ kind: "none", source: "opportunity" });
    expect(cellState({ rule: null, source: "radar", evidence: null }, undefined, user)).toEqual({ kind: "none", source: "radar" });
  });
  test("dailyState: only a setup with a rule; its own study ladder, kept apart from the ledger evidence", () => {
    const opp = { rule, source: "opportunity" as const, evidence: null, dailyStudy: null };
    expect(dailyState({ ...opp, rule: null }, undefined, user)).toBeNull();
    expect(dailyState({ ...opp, source: "rule" as never }, undefined, user)).toBeNull();
    expect(dailyState(opp, undefined, user)).toEqual({ kind: "idle", error: null });
    expect(dailyState(opp, undefined, { state: "guest" })).toEqual({ kind: "sign-in" });
    expect(dailyState(opp, { state: "running" }, user)).toEqual({ kind: "running" });
    expect(dailyState(opp, { state: "done", summary: ev }, user)).toEqual({ kind: "evidence", summary: ev });
    expect(dailyState({ ...opp, dailyStudy: ev }, undefined, { state: "guest" })).toEqual({ kind: "evidence", summary: ev });
    expect(runState(opp, undefined, user)).toEqual({ kind: "idle", error: null }); // `s` runs the daily version
    expect(runState({ ...opp, rule: null }, undefined, user)).toEqual({ kind: "none", source: "opportunity" });
  });
  test("evidence lines: facts with units, null interval omitted, empty records muted wording", () => {
    const l: LedgerEvidence = { kind: "ledger", setupKind: "k", horizon: "24h", n: 14, clusters: 6, meanNet: -0.0125, ci95: [-0.03, 0.004], hitRate: 0.4 };
    expect(ledgerText(l)).toBe("live record · 14 outcomes · 6 clusters · mean net −1.25% [−3.00%, +0.40%] · 24h");
    expect(ledgerText({ ...l, ci95: null, n: 1, clusters: 1 })).toBe("live record · 1 outcome · 1 cluster · mean net −1.25% · 24h");
    expect(ledgerText({ ...l, meanNet: null, ci95: null, clusters: 3 })).toBe("live record · 14 outcomes · 3 clusters · 24h");
    expect(ledgerText({ ...l, n: 0, clusters: 0, meanNet: null, ci95: null })).toBe("no graded outcomes yet");
    expect(scorecardText({ kind: "scorecard", stance: "fade", horizonDays: 7, n: 1, meanPct: -3.04, hitRate: 0 })).toBe("graded forward · 1 call · mean vs BTC −3.0% · hit 0%");
    expect([noEvidenceText("radar"), noEvidenceText("opportunity")]).toEqual(["no graded calls yet", "no record yet"]);
    expect(testedLabel({ tested: "short", scope: "universe" })).toBe("tested short · top-20 universe");
  });
  test("studyFailed: 401 → sign-in, else the message verbatim", () => {
    expect(studyFailed(new ApiError("unauthorized", 401))).toEqual({ state: "sign-in" });
    expect(studyFailed(new ApiError("upstream", 502))).toEqual({ state: "error", message: "upstream" });
  });
  test("rowStudyKey changes with the UTC day; scopeLabel", () => {
    expect(rowStudyKey("a", Date.parse("2026-11-09T23:59:00Z"))).toBe("a|2026-11-09");
    expect(rowStudyKey("a", Date.parse("2026-11-10T00:01:00Z"))).toBe("a|2026-11-10");
    expect([scopeLabel("coin"), scopeLabel("universe")]).toEqual(["this coin", "top-20 universe"]);
  });
});

describe("replay helpers", () => {
  const row = (over: Partial<SetupReplayRow> = {}): SetupReplayRow => ({ kind: "vol_expansion_breakout", side: "long", horizon: "24h", evaluable: true, entries: 10, n: 8, clusters: 6, meanNet: 0.01, ci95: [-0.002, 0.02], hitRate: 0.5, ...over });
  test("default horizon is 24h, else the longest the replay has", () => {
    expect(defaultReplayHorizon(["1h", "4h", "24h", "72h"])).toBe("24h");
    expect(defaultReplayHorizon(["1h", "4h"])).toBe("4h");
    expect(defaultReplayHorizon([])).toBe("");
  });
  test("rows of one horizon; kind label", () => {
    expect(replayRowsAt({ setups: [row(), row({ horizon: "1h" })] }, "1h")).toHaveLength(1);
    expect(kindLabel("negative_funding_squeeze")).toBe("negative funding squeeze");
  });
  test("facts: signed percents with the interval; null numbers are dashes with the reason, never 0", () => {
    expect(replayFacts(row())).toEqual({ mean: "+1.00%", interval: "[−0.20%, +2.00%]", hit: "50%", note: null });
    expect(replayFacts(row({ ci95: null, clusters: 2 }))).toMatchObject({ interval: "—", note: "interval needs 5+ clusters (has 2)" });
    expect(replayFacts(row({ n: 0, clusters: 0, meanNet: null, ci95: null, hitRate: null }))).toEqual({ mean: "—", interval: "—", hit: "—", note: "10 entries, none graded at 24h" });
    expect(replayFacts(row({ entries: 0, n: 0, meanNet: null, ci95: null, hitRate: null })).note).toBe("no entries in the window");
  });
  test("definition for a kind is chosen by side", () => {
    const d = (id: string, direction: "long" | "short") => ({ id, name: id, thesis: "t", rule: { ...rule, direction }, ruleText: "", intradayKinds: ["vol_expansion_breakout"] });
    const defs = { definitions: [d("range_breakout", "long"), d("range_breakdown", "short")] };
    expect(definitionForKind(defs, "vol_expansion_breakout", "short")?.id).toBe("range_breakdown");
    expect(definitionForKind(defs, "crowded_long", "short")).toBeNull();
    expect(definitionForKind(null, "vol_expansion_breakout", "long")).toBeNull();
  });
});
