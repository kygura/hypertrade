import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { PaperFill } from "../../desk/store.js";
import fills from "../../intel/fixtures/hl-userfills.json";
import type { JournalDeps } from "../../intel/journal.js";
import { MemoryIntelStore } from "../../intel/store.js";
import type { Conversation, LLMProvider, StepResult } from "../../llm/provider.js";
import { createJournalRoutes } from "./journal.js";

const NOW = new Date("2025-10-13T12:00:00Z");

class EmitProvider implements LLMProvider {
  readonly id = "anthropic" as const;
  readonly webSearch = false;
  readonly model = "fake-model";
  constructor(private readonly reply: (prompt: string) => unknown) {}
  start(_s: string, _h: unknown[], question: string): Conversation {
    const reply = this.reply;
    return {
      async step(): Promise<StepResult> {
        return { stop: "tool_use", toolCalls: [{ id: "t1", name: "emit", input: reply(question) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
      addToolResults() {},
    };
  }
}

const deskFill = (id: number, hour: number, side: "buy" | "sell", reason: string, pnl: number): PaperFill => ({
  id,
  ts: `2025-10-12T${String(hour).padStart(2, "0")}:00:00Z`,
  coin: "ETH",
  side,
  size: 1,
  px: 3000,
  fee: 0,
  pnl,
  reason,
  proposalId: null,
});

function app(provider: EmitProvider | null = null) {
  const store = new MemoryIntelStore(() => NOW);
  const deps: JournalDeps = {
    hlFills: async () => fills,
    deskFills: async () => [deskFill(1, 1, "buy", "entry", 0), deskFill(2, 2, "sell", "stop", -20)],
    store,
    llm: { makeProvider: () => provider, cache: store, now: () => NOW, dailyCap: 200 },
    now: () => NOW,
  };
  return { store, app: new Hono().route("/api/intel", createJournalRoutes(() => deps)) };
}

const send = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/intel/journal routes", () => {
  test("GET /journal returns trades, stats and sources; bad days is 400", async () => {
    const { app: a } = app();
    const res = await a.request("/api/intel/journal?days=30");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trades.map((t: { id: string }) => t.id)).toContain("hl:BTC:1001");
    expect(body.trades.map((t: { id: string }) => t.id)).toContain("desk:ETH:1");
    expect(body.stats).toEqual([expect.objectContaining({ tag: "untagged", trades: 3 })]);
    expect(body.sources.map((s: { source: string }) => s.source)).toEqual(["hl", "desk"]);

    const bad = await a.request("/api/intel/journal?days=0");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "days" });
  });

  test("PUT note validates the id and body, then shows on the trade", async () => {
    const { app: a } = app();
    expect((await a.request("/api/intel/journal/nope/note", send("PUT", { note: "x" }))).status).toBe(400);
    const tooLong = await a.request(`/api/intel/journal/${encodeURIComponent("desk:ETH:1")}/note`, send("PUT", { note: "x".repeat(501) }));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ field: "note" });
    expect((await a.request(`/api/intel/journal/${encodeURIComponent("desk:ETH:1")}/note`, send("PUT", { note: "x", extra: 1 }))).status).toBe(400);

    const ok = await a.request(`/api/intel/journal/${encodeURIComponent("desk:ETH:1")}/note`, send("PUT", { note: "stopped out on news" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ tradeId: "desk:ETH:1", note: "stopped out on news", tag: null });
    const trades = (await (await a.request("/api/intel/journal")).json()).trades;
    expect(trades.find((t: { id: string }) => t.id === "desk:ETH:1")).toMatchObject({ note: "stopped out on news" });
  });

  test("POST /journal/tag is 503 without a model, tags trades with one", async () => {
    expect((await app().app.request("/api/intel/journal/tag", send("POST", {}))).status).toBe(503);
    const { app: a } = app(new EmitProvider(() => ({ setup: "pullback", noteSummary: null })));
    expect((await a.request("/api/intel/journal/tag", send("POST", { days: 0 }))).status).toBe(400);
    const res = await a.request("/api/intel/journal/tag", send("POST", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tagged: 4, failed: 0 });
    const stats = (await (await a.request("/api/intel/journal")).json()).stats;
    expect(stats).toEqual([expect.objectContaining({ tag: "pullback", trades: 3 })]);
  });

  test("POST /journal/report stores a journal_weekly report; latest returns it", async () => {
    const { app: a } = app();
    expect(await (await a.request("/api/intel/journal/report/latest")).json()).toEqual({ report: null });
    expect((await a.request("/api/intel/journal/report", send("POST", { days: 91 }))).status).toBe(400);
    const res = await a.request("/api/intel/journal/report", send("POST", {}));
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report).toMatchObject({ kind: "journal_weekly", periodDays: 7, leaks: [], edges: [], lines: [] });
    expect(await (await a.request("/api/intel/journal/report/latest")).json()).toEqual({ report });
  });
});
