import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { AssetEvent, DiffItem, FlowFlag, ResearchResult } from "../../../shared/intel";
import type { IntelState, ResearchListResponse } from "../../lib/intel";
import { ConfluenceBadge } from "./ConfluenceBadge";
import { ChipResearchAction, DetectorChips } from "./DetectorChips";
import { DiffTable } from "./DiffTable";
import { EventList, researchHref } from "./EventList";
import {
  askDisabledReason,
  chipAskInput,
  chipQuestion,
  confluenceText,
  confluenceTitle,
  fmtCost,
  gateCleared,
  IN_FLIGHT,
  mergeResearch,
  RESEARCH_GATE_INIT,
  RESEARCH_LIST_LIMIT,
  researchGate,
  researchIntervalMs,
  STATUS_TONE,
  STATUS_WORD,
  toClaim,
  type ResearchGate,
  type ResearchGateEvent,
} from "./research";
import { ResearchCard } from "./ResearchCard";
import { ResearchPanel } from "./ResearchPanel";

// DESIGN-terminal §16: pure helpers plus render-checks (react-dom/server, no
// jsdom) of the RESEARCH panel states, the card's OBS/HYP split, the chip
// action switch, the asset research row and the confluence suffix.

const ts = "2026-10-14T12:00:00.000Z";
const result = (p: Partial<ResearchResult> = {}): ResearchResult => ({
  id: "r1", trigger: "manual", asset: "HYPE", question: "What explains the OI build on HYPE over 24 h?", status: "found",
  explanation: "A token unlock of 2.1% is scheduled for 10-15.", evidence: [], confidence: "medium", openQuestions: [],
  searches: 6, costUsd: 0.0412, model: "claude-sonnet", createdAt: ts, ...p,
});
const flag = (p: Partial<FlowFlag> = {}): FlowFlag => ({ id: "f1", asset: "HYPE", kind: "detector", name: "crowded_long", window: "24h", numbers: { funding_z: 2.4 }, score: 2, degraded: false, ts, researchId: null, ...p });
const wrap = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

describe("research helpers", () => {
  test("toClaim: observed → hostname source + ts; hypothesis keeps a seen url, never a ts", () => {
    expect(toClaim({ claim: "Unlock scheduled.", url: "https://www.theblock.co/x", ts, type: "observed" })).toEqual({ tag: "observed", text: "Unlock scheduled.", source: { label: "theblock.co", url: "https://www.theblock.co/x" }, ts });
    expect(toClaim({ claim: "Unlock scheduled.", url: "https://theblock.co/x", ts: null, type: "observed" })).toMatchObject({ tag: "observed", ts: null });
    expect(toClaim({ claim: "MMs may hedge.", url: null, ts: null, type: "hypothesis" })).toEqual({ tag: "hypothesis", text: "MMs may hedge." });
    expect(toClaim({ claim: "MMs may hedge.", url: "https://x.com/a", ts, type: "hypothesis" })).toEqual({ tag: "hypothesis", text: "MMs may hedge.", source: { label: "x.com", url: "https://x.com/a" } });
  });

  test("status words and tones: no_cause is gray, capped amber, failed red", () => {
    expect((["running", "found", "no_cause", "capped", "failed"] as const).map((s) => STATUS_WORD[s])).toEqual(["RUNNING", "FOUND", "NO CAUSE", "CAPPED", "FAILED"]);
    expect((["found", "no_cause", "capped", "failed"] as const).map((s) => STATUS_TONE[s])).toEqual(["gray", "gray", "amber", "red"]);
  });

  test("chip question, cost, confluence", () => {
    expect(chipQuestion(flag())).toBe("What explains crowded long on HYPE over 24h?");
    expect(fmtCost(0.0412)).toBe("$0.04");
    expect([undefined, 1, 0.9, 1.25, 1.5].map(confluenceText)).toEqual([null, null, null, "×1.25", "×1.50"]);
    expect(confluenceTitle(1.25, "HYPE")).toContain("×1.25 — 2 independent signal sources on HYPE");
    expect(confluenceTitle(1.5, "HYPE")).toContain("3 or more independent");
  });

  test("merge: a settled copy beats a running one from either side; two settled → server wins; newest first", () => {
    const at = "2026-10-14T13:00:00.000Z";
    const m = (local: ResearchResult[], server: ResearchResult[]) => mergeResearch(local, server).map((r) => [r.id, r.status, r.explanation]);
    // the POST resolved (local found) while the poll still had it running → found, not RUNNING
    expect(m([result({ id: "a", status: "found", createdAt: at, explanation: "local" })], [result({ id: "a", status: "running", createdAt: at, explanation: "" }), result({ id: "b" })])).toEqual([
      ["a", "found", "local"],
      ["b", "found", "A token unlock of 2.1% is scheduled for 10-15."],
    ]);
    expect(m([result({ id: "a", status: "running", createdAt: at, explanation: "" })], [result({ id: "a", status: "found", createdAt: at, explanation: "server" })])).toEqual([["a", "found", "server"]]);
    expect(m([result({ id: "a", status: "found", explanation: "local" })], [result({ id: "a", status: "no_cause", explanation: "server" })])).toEqual([["a", "no_cause", "server"]]);
  });

  test("merge: capped at 20 after sorting; the highlighted card survives the cap", () => {
    const many = Array.from({ length: 25 }, (_, i) => result({ id: `r${i}`, createdAt: new Date(Date.parse(ts) - i * 60_000).toISOString() }));
    const out = mergeResearch([], many);
    expect(out).toHaveLength(RESEARCH_LIST_LIMIT);
    expect(out[0]!.id).toBe("r0");
    expect(mergeResearch([], many, "r24").map((r) => r.id).at(-1)).toBe("r24");
  });

  test("the chip path posts question + asset + flagId", () => {
    expect(chipAskInput(flag({ id: "flag-9" }))).toEqual({ question: "What explains crowded long on HYPE over 24h?", asset: "HYPE", flagId: "flag-9" });
  });
});

describe("research gate reducer", () => {
  const T = Date.parse("2026-10-14T12:00:00.000Z");
  const reason = (gate: ResearchGate, p: { items?: ResearchResult[]; busy?: boolean; usedToday?: number; limit?: number } = {}) =>
    askDisabledReason({ busy: false, items: [], ...p, gate });
  const run = (events: ResearchGateEvent[]) => events.reduce(researchGate, RESEARCH_GATE_INIT);

  test.each<[string, ResearchGateEvent[], "enabled" | "disabled", number]>([
    ["initial", [], "enabled", 60_000],
    ["409 → disabled", [{ type: "askFailed", status: 409, at: T }], "disabled", 15_000],
    ["409, then a poll fetched before it → still disabled", [{ type: "askFailed", status: 409, at: T }, { type: "polled", running: false, fetchedAt: T - 1 }], "disabled", 15_000],
    ["409, then a later poll with a running row → still disabled", [{ type: "askFailed", status: 409, at: T }, { type: "polled", running: true, fetchedAt: T + 15_000 }], "disabled", 15_000],
    ["409, then a later poll with no running row → enabled", [{ type: "askFailed", status: 409, at: T }, { type: "polled", running: false, fetchedAt: T + 15_000 }], "enabled", 60_000],
    ["429 at 23:59Z → disabled", [{ type: "askFailed", status: 429, at: Date.parse("2026-10-14T23:59:00Z") }], "disabled", 60_000],
    ["429 at 23:59Z, poll at 23:59:30Z → disabled", [{ type: "askFailed", status: 429, at: Date.parse("2026-10-14T23:59:00Z") }, { type: "polled", running: false, fetchedAt: Date.parse("2026-10-14T23:59:30Z") }], "disabled", 60_000],
    ["429 at 23:59Z, poll at 00:01Z → enabled", [{ type: "askFailed", status: 429, at: Date.parse("2026-10-14T23:59:00Z") }, { type: "polled", running: false, fetchedAt: Date.parse("2026-10-15T00:01:00Z") }], "enabled", 60_000],
    ["500 → no gate", [{ type: "askFailed", status: 500, at: T }], "enabled", 60_000],
    ["poll with a running row → 15 s", [{ type: "polled", running: true, fetchedAt: T }], "enabled", 15_000],
  ])("%s", (_name, events, expected, interval) => {
    const g = run(events);
    // the running row itself gates through items, not the reducer
    expect(reason(g) == null ? "enabled" : "disabled").toBe(expected);
    expect(researchIntervalMs(g)).toBe(interval);
  });

  test("gateCleared fires exactly when a 409 or 429 gate lifts", () => {
    const g409 = run([{ type: "askFailed", status: 409, at: T }]);
    expect(gateCleared(g409, researchGate(g409, { type: "polled", running: false, fetchedAt: T + 1 }))).toBe(true);
    expect(gateCleared(g409, researchGate(g409, { type: "polled", running: true, fetchedAt: T + 1 }))).toBe(false);
    const g429 = run([{ type: "askFailed", status: 429, at: T }]);
    expect(gateCleared(g429, researchGate(g429, { type: "polled", running: false, fetchedAt: T + 86_400_000 }))).toBe(true);
    expect(gateCleared(RESEARCH_GATE_INIT, RESEARCH_GATE_INIT)).toBe(false);
  });

  test("other reasons: running row, busy, usage at the limit; never IN_FLIGHT once the POST resolved", () => {
    expect(reason(RESEARCH_GATE_INIT, { items: [result({ status: "running" })] })).toBe(IN_FLIGHT);
    expect(reason(RESEARCH_GATE_INIT, { busy: true })).toBe(IN_FLIGHT);
    expect(reason(RESEARCH_GATE_INIT, { usedToday: 10, limit: 10 })).toContain("(10 / 10)");
    const merged = mergeResearch([result({ id: "a", status: "found" })], [result({ id: "a", status: "running" })]);
    expect(reason(RESEARCH_GATE_INIT, { items: merged })).toBeNull();
  });
});

describe("ResearchCard", () => {
  test("OBS in the source slot, HYP muted with its url inside the text block", () => {
    const html = wrap(
      <ResearchCard
        result={result({
          evidence: [
            { claim: "Unlock of 2.1% scheduled 2026-10-15.", url: "https://theblock.co/u", ts, type: "observed" },
            { claim: "Market makers may be hedging.", url: "https://x.com/h", ts: null, type: "hypothesis" },
          ],
          openQuestions: ["Which wallets received the unlock allocation"],
        })}
      />,
    );
    const lines = html.match(/<li class="claim-line[\s\S]*?<\/li>/g) ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('data-claim="observed"');
    expect(lines[0]).toContain("theblock.co");
    expect(lines[1]).toContain('data-claim="hypothesis"');
    // the hypothesis link sits inside the muted block, not in a right-hand slot
    expect(lines[1]).toMatch(/text-text-muted[^>]*>Market makers may be hedging\. <a[^>]*href="https:\/\/x\.com\/h"/);
    expect(lines[1]).not.toContain("whitespace-nowrap");
    expect(html).toContain("OPEN QUESTIONS");
    expect(html).toContain('aria-label="Research: HYPE, found"');
    expect(html).toContain("6 SEARCHES");
    expect(html).toContain("$0.04");
    expect(html).toContain(">MEDIUM<");
    expect(html).toContain("OPEN HYPE →");
  });

  test("capped / failed print only the verbatim reason; no_cause is gray with confidence; running is a skeleton", () => {
    const capped = wrap(<ResearchCard result={result({ status: "capped", explanation: "LLM cap reached ($1.37 / $2.00)" })} />);
    expect(capped).toContain("LLM cap reached ($1.37 / $2.00)");
    expect(capped).toContain("badge--amber");
    expect(capped).not.toContain("EXPLANATION");
    const failed = wrap(<ResearchCard result={result({ status: "failed", explanation: "provider has no web search" })} />);
    expect(failed).toContain("badge--red");
    expect(failed).toContain("provider has no web search");
    expect(failed).not.toContain("SEARCHES");
    const none = wrap(<ResearchCard result={result({ status: "no_cause", explanation: "No public cause found. Checked: SOL news 24 h." })} />);
    expect(none).toContain(">NO CAUSE<");
    expect(none).not.toContain("badge--amber");
    expect(none).toContain(">MEDIUM<");
    const running = wrap(<ResearchCard result={result({ status: "running" })} />);
    expect(running).toContain("pulse-label");
    expect(running).not.toContain("EXPLANATION");
  });

  test("highlight inset and anchor; compact drops the status line", () => {
    const html = wrap(<ResearchCard result={result()} highlighted />);
    expect(html).toContain('id="research-r1"');
    expect(html).toContain("var(--color-red-accent)");
    expect(wrap(<ResearchCard result={result()} compact />)).not.toContain(">FOUND<");
  });

  test("no buy/sell language in the card chrome", () => {
    const html = wrap(<ResearchCard result={result({ explanation: "x" })} />).replace(/<[^>]+>/g, " ");
    expect(html).not.toMatch(/\b(buy|sell|long now|short now|enter|exit)\b/i);
  });
});

describe("ResearchPanel states", () => {
  const state = (p: Partial<IntelState<ResearchListResponse>>): IntelState<ResearchListResponse> => ({ data: null, loading: false, error: null, offline: null, fetchedAt: null, refetch: () => {}, setData: () => {}, ...p });
  const idle = { busy: false, error: null, status: null, offline: false };
  const render = (s: IntelState<ResearchListResponse>, p: Partial<Parameters<typeof ResearchPanel>[0]> = {}) =>
    wrap(<ResearchPanel state={s} ask={idle} items={s.data?.items ?? []} pending={null} heldWatched={new Set(["HYPE"])} highlightId={null} disabledReason={null} onAsk={() => true} {...p} />);

  test("loading, empty (no DB → memory store, same empty), error, offline; ask box always rendered", () => {
    expect(render(state({ loading: true }))).toContain("pulse-label");
    const empty = render(state({ data: { items: [], usedToday: 0, limit: 10 } }));
    expect(empty).toContain("no research yet — ask a question above, or press RESEARCH on a detector chip");
    expect(empty).toContain("QUESTION");
    expect(empty).toContain("0 / 10 TODAY");
    expect(render(state({ error: "boom" }))).toContain("boom");
    expect(render(state({ offline: "api unreachable" }))).toContain("API UNREACHABLE");
    expect(render(state({ offline: "api unreachable" }))).toContain("QUESTION");
  });

  test("a loaded list stays under a poll error; usage amber at the limit", () => {
    const html = render(state({ data: { items: [result()], usedToday: 10, limit: 10 }, error: "poll failed" }));
    expect(html).toContain("poll failed");
    expect(html).toContain('aria-label="Research: HYPE, found"');
    expect(html).toMatch(/text-amber[^>]*>10 \/ 10 TODAY/);
  });

  test("usage line omitted without usedToday/limit", () => {
    expect(render(state({ data: { items: [] } }))).not.toContain("TODAY");
  });

  test("in flight: RESEARCHING… pulse and a running placeholder card on top", () => {
    const html = render(state({ data: { items: [result()] } }), { ask: { ...idle, busy: true }, pending: { question: "Why SOL?", asset: "SOL" }, disabledReason: IN_FLIGHT });
    expect(html).toContain("RESEARCHING…");
    expect(html.indexOf('data-status="running"')).toBeLessThan(html.indexOf('data-status="found"'));
    expect(html).toContain("Why SOL?");
  });

  test("the placeholder yields to the poll's own running row (one RUNNING card)", () => {
    const html = render(state({ data: { items: [result({ status: "running", question: "Why SOL?" })] } }), { ask: { ...idle, busy: true }, pending: { question: "Why SOL?", asset: "SOL" }, disabledReason: IN_FLIGHT });
    expect(html.match(/data-status="running"/g) ?? []).toHaveLength(1);
  });

  test("409 and 429 are distinct named states with the verbatim string; RETRY only offline / 5xx", () => {
    const busy = render(state({ data: { items: [] } }), { ask: { busy: false, error: "a research run is already in flight", status: 409, offline: false }, disabledReason: IN_FLIGHT });
    expect(busy).toContain("a research run is already in flight");
    expect(busy).not.toContain("RETRY");
    const limit = render(state({ data: { items: [], usedToday: 10, limit: 10 } }), { ask: { busy: false, error: "daily research limit reached (10)", status: 429, offline: false }, disabledReason: "daily research limit reached (10 / 10) — resets 00:00 UTC" });
    expect(limit).toContain("daily research limit reached (10)");
    expect(limit).toMatch(/<button[^>]*disabled=""[^>]*title="daily research limit reached/);
    const err = render(state({ data: { items: [] } }), { ask: { busy: false, error: "upstream 502", status: 502, offline: false } });
    expect(err).toContain("RETRY");
  });

  test("highlighted card", () => {
    expect(render(state({ data: { items: [result()] } }), { highlightId: "r1" })).toContain("var(--color-red-accent)");
  });
});

describe("DetectorChips research action", () => {
  const chips = (f: FlowFlag) => wrap(<DetectorChips flags={[f]} materiality={new Map()} onResearch={() => {}} onSeeResearch={() => {}} />);
  const action = (f: FlowFlag, reason: string | null = null) => renderToStaticMarkup(<ChipResearchAction flag={f} onResearch={() => {}} onSeeResearch={() => {}} askDisabledReason={reason} />);

  test("researchId null → RESEARCH (disabled with the box's reason); set → SEE RESEARCH →", () => {
    expect(action(flag())).toContain(">RESEARCH<");
    expect(action(flag())).not.toContain('disabled=""');
    expect(action(flag(), IN_FLIGHT)).toMatch(/disabled=""[^>]*title="a research run is in flight/);
    expect(action(flag({ researchId: "r1" }))).toContain("SEE RESEARCH →");
    expect(action(flag({ researchId: "r1" }))).not.toContain(">RESEARCH<");
  });

  test("·R suffix only when research exists; no action wired → nothing", () => {
    expect(chips(flag({ researchId: "r1" }))).toContain("·R");
    expect(chips(flag())).not.toContain("·R");
    expect(renderToStaticMarkup(<ChipResearchAction flag={flag()} />)).toBe("");
  });
});

describe("EventList research row", () => {
  const ev = (p: Partial<AssetEvent>): AssetEvent => ({ ts, kind: "research", title: "What explains crowded long on HYPE over 24h?", tag: "hypothesis", ...p });
  test("with payload: a disclosure with the status word; without: SEE ON TERMINAL", () => {
    const withPayload = wrap(<EventList events={[ev({ research: result() })]} upcoming={[]} hot={null} onHover={() => {}} now={Date.parse(ts)} />);
    expect(withPayload).toContain('aria-expanded="false"');
    expect(withPayload).toContain(">FOUND<");
    expect(withPayload).toContain("RESEARCH");
    const bare = wrap(<EventList events={[ev({})]} upcoming={[]} hot={null} onHover={() => {}} now={Date.parse(ts)} />);
    expect(bare).toContain("SEE ON TERMINAL →");
    expect(bare).not.toContain("aria-expanded");
    expect(researchHref({ research: result({ id: "r7" }) })).toBe("/#research-r7?asset=HYPE");
    expect(researchHref({})).toBe("/#terminal-research");
  });
});

describe("confluence", () => {
  test("DiffTable MAT gets ×1.25 only when confluence > 1", () => {
    const item: DiffItem = { asset: "HYPE", metric: "oi_usd", held: true, from: 1e9, to: 1.2e9, delta: 18.4, deltaUnit: "pct", z: 3.1, exposureWeight: 0.5, stopProximity: 1, materiality: 0.71, ts, baselineTs: ts, confluence: 1.25 };
    expect(wrap(<DiffTable items={[item]} />)).toContain("×1.25");
    expect(wrap(<DiffTable items={[{ ...item, confluence: 1 }]} />)).not.toContain("×");
    expect(wrap(<DiffTable items={[{ ...item, confluence: undefined }]} />)).not.toContain("×");
    expect(renderToStaticMarkup(<ConfluenceBadge factor={1.5} asset="SOL" />)).toContain("3 or more");
  });
});
