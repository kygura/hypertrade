import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { UNIVERSE_ASSET, type BoardResponse, type LedgerEvidence, type RadarResponse, type ScorecardEvidence, type StudySummary } from "../../../shared/research";
import type { Rule } from "../../lib/lab";
import { rowStudyKey, type Auth, type BoardSignal, type RowStudy } from "../../lib/research";
import { BoardView, chipTitle, emptyLabel, evidenceText, type BoardViewProps } from "./Board";

// Render-checks (react-dom/server, no jsdom), the cockpit render.test.tsx approach: the §6 ladder per region,
// each evidence-cell variant, source chips, pulse null and the radar states.

const noop = () => {};
const NOW = Date.parse("2026-11-09T12:00:00Z");
const rule: Rule = { asset: "BTC", direction: "long", horizonDays: 5, conditions: [{ feature: "ht:funding|z|30", op: "<", threshold: -1 }] };
const ok = (count: number) => ({ state: "ok" as const, count, dropped: 0 });
const summary: StudySummary = { verdict: "clear", events: 41, weeks: 38, expectancy: 0.21, upper95: 0.35, holdoutExpectancy: 0.1, idea: { n: 3, of: 9 }, asOf: "2026-11-09T11:00:00Z" };
const sig = (id: string, over: Partial<BoardSignal> = {}): BoardSignal => ({
  id, source: "novelty", coin: "ETH", direction: null, tested: null, scope: "coin", headline: "funding z90 +2.4", at: NOW - 3_600_000, rule: null, ruleText: null, href: null, evidence: null, dailyStudy: null, definitionId: null, ...over,
});
const boardData = (signals: BoardSignal[], over: Partial<BoardResponse> = {}): BoardResponse => ({
  asOf: "2026-11-09T12:00:00Z", signals, sources: { novelty: ok(signals.length), rule: ok(0), opportunity: ok(0), radar: ok(0), definition: ok(0) }, pulse: { assets: 12, firing: 2 }, ...over,
});
const poll = <T,>(data: T | null, over: { loading?: boolean; error?: string | null; offline?: string | null } = {}) => ({ data, loading: false, error: null, offline: null, refetch: noop, ...over });
const radarOk: RadarResponse = {
  state: "ok", latestNote: { date: "2026-11-08", markdown: "# note", truncated: false },
  calls: [{ id: "c1", date: "2026-11-08", at: "2026-11-08T08:00:00Z", market: "HYPE", stance: "ride", direction: "long", kind: "catalyst", thesis: "a dated unlock", cause_url: "https://x.example", cause_date: "2026-11-07", kill_price: 30, kill_if: "close below 30", mark: 33, btc: 90000, rel: {}, killed_at: null }],
  scorecard: [{ stance: "ride", horizonDays: 3, n: 4, meanPct: 2.1, hits: 3 }],
};

const render = (over: Partial<BoardViewProps> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={["/board"]}>
      <BoardView
        board={poll(boardData([]))}
        radar={poll(radarOk)}
        auth={{ state: "user" }}
        onAuthRetry={noop}
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
    const b = boardData([], { sources: { novelty: ok(0), rule: ok(0), opportunity: { state: "unavailable", reason: "platform offline (no worker loop and no database)", count: 0, dropped: 0 }, radar: ok(0), definition: { state: "unavailable", reason: "needs a database (DATABASE_URL unset)", count: 0, dropped: 0 } } });
    const html = render({ board: poll(b) });
    expect(html).toContain("no condition firing · sources on: novelty, rule, radar");
    expect(html).not.toContain('role="alert"');
    expect(emptyLabel(b, "doge")).toBe("no signal on DOGE now");
  });
  test("chip title names dropped items", () => {
    expect(chipTitle({ state: "ok", count: 2, dropped: 1 })).toBe("2 signals now · 1 item dropped as invalid (server log)");
    expect(chipTitle({ state: "ok", count: 2, dropped: 3 }, "definition")).toBe("2 signals now · 3 items not evaluable today (data missing, late or not yet on the bar)");
    expect(chipTitle({ state: "unavailable", reason: "sign in required", count: 0, dropped: 0 })).toBe("sign in required");
  });
  test("pulse panel shows the board error ladder, not a blank", () => {
    expect(render({ board: poll<BoardResponse>(null, { offline: "api unreachable" }) })).toContain("api unreachable");
  });
  test("source unavailable chip: `unavailable` with the reason as title; ok chip shows the count", () => {
    const b = boardData([sig("n1")], { sources: { novelty: ok(1), rule: ok(0), opportunity: { state: "unavailable", reason: "timed out", count: 0, dropped: 0 }, radar: ok(0), definition: ok(0) } });
    const html = render({ board: poll(b) });
    expect(html).toContain('title="timed out"');
    expect(html).toContain("SETUP unavailable");
    expect(html).toContain("NOVELTY 1");
  });
});

describe("source note", () => {
  const note = "scanner ticks about 4 times a day: the intraday features need 96, so 0 signals means could not fire";
  const withNote = () => boardData([sig("n1")], { sources: { novelty: ok(1), rule: ok(0), opportunity: { state: "ok", count: 0, dropped: 0, note }, radar: ok(0), definition: ok(0) } });
  test("visible text under the chips (not hover-only) and a marker on the chip, naming its source", () => {
    const html = render({ board: poll(withNote()) });
    expect(html).toContain(`SETUP: ${note}`);
    expect(html).toContain("SETUP 0");
    expect(html).toContain(`title="0 signals now · ${note}"`);
  });
  test("no note, no line; the other chips carry no marker", () => {
    const html = render({ board: poll(boardData([sig("n1")])) });
    expect(html).not.toContain("SETUP:");
    expect(html).not.toContain("scanner ticks");
    expect(chipTitle({ state: "ok", count: 1, dropped: 0, note: "n" })).toBe("1 signal now · n");
  });
});

describe("evidence cell", () => {
  const rows = (local: Record<string, RowStudy> = {}, auth: Auth = { state: "user" }) =>
    render({
      auth,
      studies: Object.fromEntries(Object.entries(local).map(([id, v]) => [rowStudyKey(id, NOW), v])),
      board: poll(
        boardData([
          sig("cached", { coin: "BTC", source: "rule", rule, evidence: { ...summary, kind: "study" }, tested: "short", at: NOW - 1000 }),
          sig("fresh", { coin: "SOL", rule, ruleText: "funding z(30) < −1 → long 5d", at: NOW - 2000 }),
          sig("wide", { coin: "ETH", rule, scope: "universe", tested: "short", evidence: { ...summary, kind: "study", verdict: "insufficient" }, at: NOW - 2500 }),
          sig("bare", { coin: "HYPE", source: "opportunity", direction: "short", href: "/feed?id=x", at: NOW - 3000 }),
        ]),
      ),
    });
  test("cached study: verdict text + colour and the facts line with the tested side", () => {
    const html = rows();
    expect(html).toContain("CLEAR");
    expect(html).toContain("text-green");
    expect(html).toContain("tested short · this coin · 41 events · 38 weeks · +0.21R (≤ +0.35R)");
    expect(html).toContain("tested short · top-20 universe · 41 events");
    expect(html).toContain("funding z(30) &lt; −1 → long 5d");
    expect(evidenceText(summary, { tested: null, scope: "coin" })).toBe("this coin · 41 events · 38 weeks · +0.21R (≤ +0.35R)");
  });
  test("rule without evidence: STUDY button; running, error and result in the cell", () => {
    expect(rows()).toContain(">STUDY</button>");
    expect(rows({ fresh: { state: "running" } })).toContain("STUDYING this coin…");
    const err = rows({ fresh: { state: "error", message: "upstream 502" } });
    expect(err).toContain("upstream 502");
    expect(err).toContain("RETRY STUDY");
    expect(rows({ fresh: { state: "done", summary: { ...summary, verdict: "rejected" } } })).toContain("REJECTED");
  });
  test("no rule, no evidence: a muted factual line; source drill and asset links", () => {
    const html = rows();
    expect(html).toContain("no record yet");
    expect(html).toContain('href="/feed?id=x"');
    expect(html).toContain('href="/asset/HYPE"');
    expect(html).not.toContain("twin");
  });
  test("guest: the sign-in affordance instead of a POST", () => {
    const html = rows({}, { state: "guest" });
    expect(html).toContain("LOGIN TO STUDY");
    expect(html).not.toContain(">STUDY</button>");
  });
  test("rows link the prefilled study on their coin", () => {
    expect(rows()).toContain(`href="/lab/study?rule=${encodeURIComponent(JSON.stringify(rule)).replace(/&/g, "&amp;")}&amp;coin=SOL"`);
  });
});

const ledger: LedgerEvidence = { kind: "ledger", setupKind: "crowded_long", horizon: "24h", n: 14, clusters: 6, meanNet: 0.0042, ci95: [-0.001, 0.0095], hitRate: 0.57 };
const scorecard: ScorecardEvidence = { kind: "scorecard", stance: "ride", horizonDays: 7, n: 4, meanPct: 2.1, hitRate: 0.75 };
const dailyRule: Rule = { asset: UNIVERSE_ASSET, direction: "short", horizonDays: 7, conditions: [{ feature: "ht:funding|z|90", op: ">=", threshold: 2 }] };

describe("evidence kinds", () => {
  const board = (signals: BoardSignal[], over: Partial<BoardViewProps> = {}) => render({ board: poll(boardData(signals)), ...over });
  const opp = (over: Partial<BoardSignal> = {}) =>
    sig("opp", { coin: "HYPE", source: "opportunity", direction: "short", href: "/feed?id=x", evidence: ledger, rule: dailyRule, ruleText: "funding z(90) ≥ 2 → short 7d", scope: "universe", tested: "short", definitionId: "funding_fade", ...over });

  test("ledger: a fact line with n, clusters, mean and interval in %, no verdict badge or colour", () => {
    const html = board([opp({ rule: null, ruleText: null, tested: null, definitionId: null })]);
    expect(html).toContain("live record · 14 outcomes · 6 clusters · mean net +0.42% [−0.10%, +0.95%] · 24h");
    expect(html).not.toMatch(/CLEAR|REJECTED|INSUFFICIENT/);
    expect(html).not.toContain("STUDY DAILY VERSION");
    expect(html).not.toContain(">STUDY</button>");
    expect(ledgerLine(html)).not.toMatch(/text-green|text-red/);
  });
  test("ledger: null interval is omitted, n 0 is muted text", () => {
    expect(board([opp({ rule: null, evidence: { ...ledger, ci95: null, clusters: 3 } })])).toContain("14 outcomes · 3 clusters · mean net +0.42% · 24h");
    const empty = board([opp({ rule: null, evidence: { ...ledger, n: 0, clusters: 0, meanNet: null, ci95: null, hitRate: null } })]);
    expect(empty).toMatch(/text-text-secondary[^>]*title="no outcome[^>]*>no graded outcomes yet</);
    expect(empty).not.toContain("live record");
  });
  test("scorecard: graded forward, calls, mean vs BTC, hit %; null is a muted line", () => {
    const html = board([sig("r1", { coin: "HYPE", source: "radar", direction: "long", evidence: scorecard })]);
    expect(html).toContain("graded forward · 4 calls · mean vs BTC +2.1% · hit 75%");
    expect(html).not.toContain(">STUDY</button>");
    const none = board([sig("r2", { coin: "SOL", source: "radar" })]);
    expect(none).toMatch(/text-text-secondary[^>]*>no graded calls yet</);
  });
  test("setup with a daily rule: ledger line plus STUDY DAILY VERSION whose title never claims to test the intraday setup", () => {
    const html = board([opp()]);
    expect(html).toContain("live record · 14 outcomes");
    expect(html).toContain(">STUDY DAILY VERSION</button>");
    expect(html).toMatch(/title="[^"]*daily-bar definition[^"]*does not test the intraday setup itself[^"]*counts as a trial"/);
    expect(html).toContain("not studied today · tested short · top-20 universe");
    expect(html).not.toContain(">STUDY</button>");
    // The daily definition's rule text under the setup's headline is labelled, never read as the setup's own condition.
    expect(html).toMatch(/<p class="text-xs text-text-secondary[^"]*"><span[^>]*>daily version: <\/span>funding z\(90\) ≥ 2 → short 7d<\/p>/);
  });
  test("setup: the cached daily study shows under the ledger line, prefixed `daily version:`; a local run does too", () => {
    const cached = board([opp({ dailyStudy: summary })]);
    expect(cached).toContain("daily version:");
    expect(cached).toContain("CLEAR");
    expect(cached).toContain("tested short · top-20 universe · 41 events · 38 weeks · +0.21R (≤ +0.35R)");
    expect(cached.indexOf("live record")).toBeLessThan(cached.lastIndexOf("daily version:")); // the first is the rule-text label
    expect(cached).not.toContain("STUDY DAILY VERSION");
    const ran = render({ board: poll(boardData([opp()])), studies: { [rowStudyKey("opp", NOW)]: { state: "done", summary: { ...summary, verdict: "rejected" } } } });
    expect(ran).toContain("daily version:");
    expect(ran).toContain("REJECTED");
    expect(render({ board: poll(boardData([opp()])), studies: { [rowStudyKey("opp", NOW)]: { state: "running" } } })).toContain("STUDYING top-20 universe…");
    expect(render({ board: poll(boardData([opp()])), studies: { [rowStudyKey("opp", NOW)]: { state: "error", message: "upstream 502" } } })).toContain("RETRY DAILY STUDY");
  });
  test("setup daily version: a guest gets LOGIN TO STUDY", () => {
    const html = board([opp()], { auth: { state: "guest" } });
    expect(html).toContain("LOGIN TO STUDY");
    expect(html).toContain("live record");
  });
  test("definition row: headline, rule text, tested side and universe, STUDY; the row links the universe study without a coin", () => {
    const d = sig("def", { coin: "SOL", source: "definition", direction: null, headline: "funding z90 +2.4, OI p95", rule: dailyRule, ruleText: "funding z(90) ≥ 2 → short 7d", scope: "universe", tested: "short", definitionId: "funding_fade" });
    const html = board([d]);
    expect(html).toContain("DEFINITION");
    expect(html).toContain("funding z90 +2.4, OI p95");
    expect(html).toContain("funding z(90) ≥ 2 → short 7d");
    expect(html).toContain("not studied today · tested short · top-20 universe");
    expect(html).toContain(">STUDY</button>");
    expect(html).toContain('href="/asset/SOL"');
    expect(html).toContain('href="/moves?coin=SOL"');
    // The study link carries no coin scope (only the MOVES cross-link does).
    expect(html.replace(/\/moves\?coin=[^"]*/g, "")).not.toContain("coin=");
    expect(html).not.toContain('/asset/UNIVERSE');
    expect(html).not.toContain(">UNIVERSE<");
  });
  test("the source chip for definition sits with the others", () => {
    const b = boardData([], { sources: { novelty: ok(0), rule: ok(0), opportunity: ok(0), radar: ok(0), definition: ok(2) } });
    expect(render({ board: poll(b) })).toContain("DEFINITION 2");
  });
});

/** The ledger fact line's own span (its classes). */
const ledgerLine = (html: string) => html.match(/<span[^>]*>live record[^<]*<\/span>/)?.[0] ?? "";

describe("side column", () => {
  test("pulse counts link /lab/pulse; pulse null says unavailable with the reason", () => {
    expect(render()).toContain("2 catalogued rules firing · 12 assets covered");
    expect(render()).toContain('href="/lab/pulse"');
    const b = boardData([], { pulse: null, sources: { novelty: ok(0), rule: { state: "unavailable", reason: "source failed (see server log)", count: 0, dropped: 0 }, opportunity: ok(0), radar: ok(0), definition: ok(0) } });
    expect(render({ board: poll(b) })).toContain("pulse unavailable — source failed (see server log)");
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
    expect(render({ radar: poll<RadarResponse>({ state: "unavailable", reason: "radar files not deployed", latestNote: null, calls: [], scorecard: [] }) })).toContain("radar unavailable — radar files not deployed");
    expect(render({ auth: { state: "guest" }, radar: poll<RadarResponse>(null) })).toContain("the radar needs a signed-in session");
    const failed = render({ auth: { state: "error", message: "api unreachable" }, radar: poll<RadarResponse>(null) });
    expect(failed).toContain("session check failed: api unreachable");
    expect(failed).toContain("RETRY");
  });
});
