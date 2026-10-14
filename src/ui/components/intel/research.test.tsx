import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { AssetEvent, DiffItem, FlowFlag, ResearchResult } from "../../../shared/intel";
import type { IntelState, ResearchListResponse } from "../../lib/intel";
import { ConfluenceBadge } from "./ConfluenceBadge";
import { ChipResearchAction, DetectorChips } from "./DetectorChips";
import { DiffTable } from "./DiffTable";
import { EventList } from "./EventList";
import { askDisabledReason, askState, chipQuestion, confluenceText, confluenceTitle, fmtCost, IN_FLIGHT, mergeResearch, statusTone, statusWord, toClaim } from "./research";
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
    expect((["running", "found", "no_cause", "capped", "failed"] as const).map(statusWord)).toEqual(["RUNNING", "FOUND", "NO CAUSE", "CAPPED", "FAILED"]);
    expect((["found", "no_cause", "capped", "failed"] as const).map(statusTone)).toEqual(["gray", "gray", "amber", "red"]);
  });

  test("chip question, cost, confluence", () => {
    expect(chipQuestion(flag())).toBe("What explains crowded long on HYPE over 24h?");
    expect(fmtCost(0.0412)).toBe("$0.04");
    expect([undefined, 1, 0.9, 1.25, 1.5].map(confluenceText)).toEqual([null, null, null, "×1.25", "×1.50"]);
    expect(confluenceTitle(1.25, "HYPE")).toContain("×1.25 — 2 independent signal sources on HYPE");
    expect(confluenceTitle(1.5, "HYPE")).toContain("3 or more independent");
  });

  test("merge: local first, dedup by id (server wins), newest first", () => {
    const local = [result({ id: "a", status: "running", createdAt: "2026-10-14T13:00:00.000Z" })];
    const server = [result({ id: "a", status: "found", createdAt: "2026-10-14T13:00:00.000Z" }), result({ id: "b" })];
    expect(mergeResearch(local, server).map((r) => [r.id, r.status])).toEqual([["a", "found"], ["b", "found"]]);
  });

  test("named ask states and gating: 409 and 429 are distinct", () => {
    expect(askState({ error: null, status: null, offline: false })).toBe("idle");
    expect(askState({ error: "research already running", status: 409, offline: false })).toBe("busy");
    expect(askState({ error: "daily research limit reached", status: 429, offline: false })).toBe("limit");
    expect(askState({ error: "boom", status: 500, offline: false })).toBe("error");
    expect(askState({ error: "api unreachable", status: null, offline: true })).toBe("offline");
    const base = { busy: false, items: [], conflict: false, limitDay: null, now: Date.parse(ts) };
    expect(askDisabledReason(base)).toBeNull();
    expect(askDisabledReason({ ...base, items: [result({ status: "running" })] })).toBe(IN_FLIGHT);
    expect(askDisabledReason({ ...base, conflict: true })).toBe(IN_FLIGHT);
    expect(askDisabledReason({ ...base, usedToday: 10, limit: 10 })).toContain("(10 / 10)");
    expect(askDisabledReason({ ...base, limitDay: "2026-10-14" })).toContain("daily research limit");
    expect(askDisabledReason({ ...base, limitDay: "2026-10-13" })).toBeNull(); // the UTC day turned
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
    wrap(<ResearchPanel state={s} ask={idle} local={[]} pending={null} heldWatched={new Set(["HYPE"])} highlightId={null} disabledReason={null} onAsk={() => {}} {...p} />);

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

  test("409 and 429 are distinct named states with the verbatim string; RETRY only offline / 5xx", () => {
    const busy = render(state({ data: { items: [] } }), { ask: { busy: false, error: "a research run is already in flight", status: 409, offline: false }, disabledReason: IN_FLIGHT });
    expect(busy).toContain('data-ask-state="busy"');
    expect(busy).toContain("a research run is already in flight");
    expect(busy).not.toContain("RETRY");
    const limit = render(state({ data: { items: [], usedToday: 10, limit: 10 } }), { ask: { busy: false, error: "daily research limit reached (10)", status: 429, offline: false }, disabledReason: "daily research limit reached (10 / 10) — resets 00:00 UTC" });
    expect(limit).toContain('data-ask-state="limit"');
    expect(limit).toContain("daily research limit reached (10)");
    expect(limit).toMatch(/<button[^>]*disabled=""[^>]*title="daily research limit reached/);
    const err = render(state({ data: { items: [] } }), { ask: { busy: false, error: "upstream 502", status: 502, offline: false } });
    expect(err).toContain('data-ask-state="error"');
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
