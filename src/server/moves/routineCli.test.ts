import { describe, expect, test } from "bun:test";
import type { TriageResponse } from "../../shared/agentRecords.js";
import { detail, iso, record, T0 } from "./agent.fixture.js";
import { formatItem, formatProposalReply, formatTriage, needsProposal, parseProposal, proposalRequest, routineConfig, triageRequest } from "./routineCli.js";

const day = "2026-11-11";
const item = (coin: string, over: Partial<TriageResponse["items"][number]> = {}): TriageResponse["items"][number] => ({
  id: `${day}:${coin}`, day, coin, reason: "residual +6.2% · z +3.1 · 24h · no news in window", score: 1, residualZ: 3.1, surfacedAt: iso(T0), dismissedAt: null, recordId: null, record: null, ...over,
});
const triage = (items: TriageResponse["items"]): TriageResponse => ({
  state: "ok", reason: null, day, budget: 8, surfaced: items.length, overBudget: 0, watched: 38, agentRuns: 1, agentCap: 6, agentBlockedReason: null, items,
});

describe("routine CLI (pure)", () => {
  test("config needs APP_URL and the bearer; requests carry it and never a body on GET", () => {
    expect(() => routineConfig({ LAB_API_TOKEN: "t" })).toThrow("APP_URL not set");
    expect(() => routineConfig({ APP_URL: "https://x.example" })).toThrow("LAB_API_TOKEN not set");
    const cfg = routineConfig({ APP_URL: "https://x.example/", LAB_API_TOKEN: " , tok-a,tok-b" });
    expect(triageRequest(cfg)).toEqual({ url: "https://x.example/api/moves/triage", init: { method: "GET", headers: { accept: "application/json", authorization: "Bearer tok-a" } } });
    const p = parseProposal(JSON.stringify({ claim: "", layer: "unexplained", direction: null }));
    if (!p.ok) throw new Error(p.error);
    const r = proposalRequest(cfg, "kPEPE", p.proposal);
    expect(r.url).toBe("https://x.example/api/moves/kPEPE/proposal");
    expect(r.init.method).toBe("POST");
    expect((r.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(r.init.body as string)).toEqual({ claim: "", layer: "unexplained", direction: null, assets: [], horizonHours: 24, falsifier: null, sources: [] });
  });

  test("triage lists open items without a record, with code's facts and the falsifier band", () => {
    const t = triage([item("SOL"), item("WIF", { dismissedAt: iso(T0) }), item("JUP", { recordId: "r1", record: record({ id: "r1", coin: "JUP" }) })]);
    expect(needsProposal(t).map((i) => i.coin)).toEqual(["SOL"]);
    const text = formatTriage(t, new Map([["SOL", { detail: detail() }]]));
    expect(text).toContain("agent runs 1/6 · 1 of 3 surfaced need a proposal");
    expect(text).toContain("move: total +7.20% = btc +0.80 + eth +0.10 + sector +0.10 + residual +6.20 (z +3.10, R² 0.55)");
    expect(text).toContain("crowded long 0/4 short 0/4");
    expect(text).toContain("falsifier band: long (side below) 8.8692-9.9005 · short (side above) 10.1005-11.275");
    expect(text).toContain("- SOL ecosystem fund announced");
    expect(formatItem(item("SOL"), null, "HTTP 503")).toContain("no detail: HTTP 503");
    expect(formatTriage(triage([]), new Map())).toContain("nothing to investigate");
  });

  test("a proposal file is checked locally; the reply prints the record or the refusal", () => {
    expect(parseProposal("{")).toMatchObject({ ok: false, error: expect.stringContaining("not JSON") });
    expect(parseProposal(JSON.stringify({ claim: "x", layer: "unexplained", direction: "long", status: "graded" }))).toMatchObject({ ok: false, error: expect.stringContaining("invalid proposal") });
    const ok = formatProposalReply(200, record({ id: "r9", trigger: "routine", model: "routine" }));
    expect(ok.code).toBe(0);
    expect(ok.text.split("\n")[0]).toBe("stored r9 · SOL · open · forced_flow · long · 24h · falsifier below 95 · dropped 0");
    expect(formatProposalReply(409, { error: "the SOL triage item already has record r1" })).toEqual({ text: "refused (HTTP 409): the SOL triage item already has record r1", code: 1 });
    expect(formatProposalReply(503, { error: "unavailable", reason: "no BTC mark" }).text).toBe("refused (HTTP 503): no BTC mark");
  });
});
