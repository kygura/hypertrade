import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Rule, StudyResult } from "../lib/lab";
import { parseRuleParam, ruleDrillHref, studyArgs, studyHref } from "../lib/study";
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
  ...over,
});

const props = (over: Partial<StudyViewProps> = {}): StudyViewProps => ({
  parsedError: null,
  rule,
  coin: "BTC",
  universe: { kind: "top", n: 20 },
  onUniverse: noop,
  study: { data: null, loading: false, error: null, offline: false, refetch: noop },
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
