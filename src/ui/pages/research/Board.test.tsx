import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { BoardResponse, RadarResponse, StudySummary } from "../../../shared/research";
import type { Rule } from "../../lib/lab";
import type { BoardSignal } from "../../lib/research";
import { BoardView, emptyLabel, evidenceText, type BoardViewProps, type RowStudy } from "./Board";

// Render-checks (react-dom/server, no jsdom), the cockpit render.test.tsx approach: the §6 ladder per region,
// each evidence-cell variant, source chips, pulse null and the radar states.

const noop = () => {};
const NOW = Date.parse("2026-11-09T12:00:00Z");
const rule: Rule = { asset: "BTC", direction: "long", horizonDays: 5, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1 }] };
const ok = (count: number) => ({ state: "ok" as const, count });
const summary: StudySummary = { verdict: "clear", events: 41, weeks: 38, expectancy: 0.21, upper95: 0.35, holdoutExpectancy: 0.1, idea: { n: 3, of: 9 }, asOf: "2026-11-09T11:00:00Z" };
const sig = (id: string, over: Partial<BoardSignal> = {}): BoardSignal => ({
  id, source: "novelty", coin: "ETH", direction: null, headline: "funding z90 +2.4", at: NOW - 3_600_000, rule: null, ruleText: null, href: null, evidence: null, ...over,
});
const boardData = (signals: BoardSignal[], over: Partial<BoardResponse> = {}): BoardResponse => ({
  asOf: "2026-11-09T12:00:00Z", signals, sources: { novelty: ok(signals.length), rule: ok(0), opportunity: ok(0), radar: ok(0) }, pulse: { assets: 12, firing: 2 }, ...over,
});
const poll = <T,>(data: T | null, over: { loading?: boolean; error?: string | null; offline?: string | null } = {}) => ({ data, loading: false, error: null, offline: null, refetch: noop, ...over });
const radarOk: RadarResponse = {
  state: "ok", latestNote: { date: "2026-11-08", markdown: "# note" },
  calls: [{ id: "c1", date: "2026-11-08", at: "2026-11-08T08:00:00Z", market: "HYPE", stance: "ride", direction: "long", kind: "catalyst", thesis: "a dated unlock", cause_url: "https://x.example", cause_date: "2026-11-07", kill_price: 30, kill_if: "close below 30", mark: 33, btc: 90000, rel: {}, killed_at: null }],
  scorecard: [{ stance: "ride", horizonDays: 3, n: 4, meanPct: 2.1, hits: 3 }],
};

const render = (over: Partial<BoardViewProps> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <BoardView
        board={poll(boardData([]))}
        radar={poll(radarOk)}
        guest={false}
        coin={null}
        now={NOW}
        studies={{}}
        selectedId={null}
        onSelect={noop}
        onOpen={noop}
        onStudy={noop}
        onClearCoin={noop}
        onSignIn={noop}
        {...over}
      />
    </MemoryRouter>,
  );

describe("board states", () => {
  test("loading: skeleton, no empty copy; BOARD tab checked first in the research row", () => {
    const html = render({ board: poll<BoardResponse>(null, { loading: true }) });
    expect(html).toContain("pulse-label");
    expect(html).not.toContain("no condition firing");
    const tabs = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? html.match(/<button[^>]*aria-checked[^>]*>/g) ?? [];
    expect(tabs[0]).toContain('aria-checked="true"');
    expect(html).toContain("BOARD");
  });
  test("error: the server string verbatim", () => {
    expect(render({ board: poll<BoardResponse>(null, { error: "board exploded" }) })).toContain("board exploded");
  });
  test("empty with sources on: names them, not an error", () => {
    const b = boardData([], { sources: { novelty: ok(0), rule: ok(0), opportunity: { state: "unavailable", reason: "platform offline", count: 0 }, radar: ok(0) } });
    const html = render({ board: poll(b) });
    expect(html).toContain("no condition firing · sources on: novelty, rule, radar");
    expect(html).not.toContain('role="alert"');
    expect(emptyLabel(b, "doge")).toBe("no signal on DOGE now");
  });
  test("source unavailable chip: `unavailable` with the reason as title; ok chip shows the count", () => {
    const b = boardData([sig("n1")], { sources: { novelty: ok(1), rule: ok(0), opportunity: { state: "unavailable", reason: "platform offline: no scanner", count: 0 }, radar: ok(0) } });
    const html = render({ board: poll(b) });
    expect(html).toContain('title="platform offline: no scanner"');
    expect(html).toContain("SETUP unavailable");
    expect(html).toContain("NOVELTY 1");
  });
});

describe("evidence cell", () => {
  const rows = (studies: Record<string, RowStudy> = {}, guest: boolean | null = false) =>
    render({
      guest,
      studies,
      board: poll(
        boardData([
          sig("cached", { coin: "BTC", source: "rule", rule, evidence: summary, tested: "short", at: NOW - 1000 }),
          sig("fresh", { coin: "SOL", rule, at: NOW - 2000 }),
          sig("twin", { coin: "HYPE", source: "opportunity", direction: "short", href: "/feed?id=x", at: NOW - 3000 }),
        ]),
      ),
    });
  test("cached study: verdict text + colour and the facts line with the tested side", () => {
    const html = rows();
    expect(html).toContain("CLEAR");
    expect(html).toContain("text-green");
    expect(html).toContain("tested short · 41 events · 38 weeks · +0.21R (≤ +0.35R)");
    expect(evidenceText(summary, null)).toBe("41 events · 38 weeks · +0.21R (≤ +0.35R)");
  });
  test("rule without evidence: STUDY button; running, error and result in the cell", () => {
    expect(rows()).toContain(">STUDY</button>");
    expect(rows({ fresh: { state: "running" } })).toContain("STUDYING…");
    const err = rows({ fresh: { state: "error", message: "upstream 502" } });
    expect(err).toContain("upstream 502");
    expect(err).toContain("RETRY STUDY");
    expect(rows({ fresh: { state: "done", summary: { ...summary, verdict: "rejected" } } })).toContain("REJECTED");
  });
  test("no rule: muted `no Lab twin` with the reason; source drill and asset links", () => {
    const html = rows();
    expect(html).toContain("no Lab twin");
    expect(html).toContain("intraday scanner setups have no Lab twin");
    expect(html).toContain('href="/feed?id=x"');
    expect(html).toContain('href="/asset/HYPE"');
  });
  test("guest: the sign-in affordance instead of a POST", () => {
    const html = rows({}, true);
    expect(html).toContain("LOGIN TO STUDY");
    expect(html).not.toContain(">STUDY</button>");
  });
  test("rows link the prefilled study on their coin", () => {
    expect(rows()).toContain(`href="/lab/study?rule=${encodeURIComponent(JSON.stringify(rule)).replace(/&/g, "&amp;")}&amp;coin=SOL"`);
  });
});

describe("side column", () => {
  test("pulse counts link /lab/pulse; pulse null says unavailable with the reason", () => {
    expect(render()).toContain("2 catalogued rules firing · 12 assets covered");
    expect(render()).toContain('href="/lab/pulse"');
    const b = boardData([], { pulse: null, sources: { novelty: ok(0), rule: { state: "unavailable", reason: "catalogue unreadable", count: 0 }, opportunity: ok(0), radar: ok(0) } });
    expect(render({ board: poll(b) })).toContain("pulse unavailable — catalogue unreadable");
  });
  test("radar: note date, calls with stance and kill, scorecard n/mean/hit", () => {
    const html = render();
    expect(html).toContain("latest note 2026-11-08");
    expect(html).toContain("READ NOTE");
    expect(html).toContain("kill 30");
    expect(html).toContain("+2.1%");
    expect(html).toContain("3/4");
  });
  test("radar unavailable and guest", () => {
    expect(render({ radar: poll<RadarResponse>({ state: "unavailable", reason: "no radar directory", latestNote: null, calls: [], scorecard: [] }) })).toContain("radar unavailable — no radar directory");
    expect(render({ guest: true, radar: poll<RadarResponse>(null) })).toContain("the radar needs a signed-in session");
  });
});
