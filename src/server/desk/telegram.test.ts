import { describe, expect, test } from "bun:test";
import { createNotifier, escapeHtml, telegramPayload } from "./notify.js";
import { handleTelegramUpdate } from "./telegram.js";
import { makeService } from "./testkit.js";
import { toWatchedAccount, trimForModel } from "./data.js";
import type { Brief } from "../../shared/intel.js";
import { feedbackActions } from "../intel/notify.js";
import { MemoryIntelStore, type NewAlert } from "../intel/store.js";

function recorder() {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const trade = {
  coin: "ETH",
  side: "long" as const,
  setup: "telegram test",
  thesis: "A long to approve from Telegram, long enough to pass.",
  horizon: "swing" as const,
  confidence: "medium" as const,
  stop: 3800,
  target: 4500,
  riskPct: 0.5,
  invalidation: "close under 3850",
  evidence: [
    { source: "a", point: "one" },
    { source: "b", point: "two" },
  ],
};

describe("telegram control", () => {
  test("an Approve button press from the operator's chat executes the proposal", async () => {
    const { service } = makeService({ env: { DESK_APPROVAL: "manual" } });
    const rec = await service.submitOpen(trade, null);
    const { calls, fetchFn } = recorder();
    await handleTelegramUpdate(service, { update_id: 1, callback_query: { id: "cq", data: `approve:${rec.id}`, message: { chat: { id: 42 }, message_id: 7 } } }, { token: "T", chatId: "42", fetchFn });
    expect((await service.store.getProposal(rec.id))!.status).toBe("executed");
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["answerCallbackQuery", "editMessageReplyMarkup", "sendMessage"]);
  });

  test("updates from other chats are ignored", async () => {
    const { service } = makeService({ env: { DESK_APPROVAL: "manual" } });
    const rec = await service.submitOpen(trade, null);
    const { calls, fetchFn } = recorder();
    await handleTelegramUpdate(service, { update_id: 1, callback_query: { id: "cq", data: `approve:${rec.id}`, message: { chat: { id: 666 }, message_id: 7 } } }, { token: "T", chatId: "42", fetchFn });
    await handleTelegramUpdate(service, { update_id: 2, message: { chat: { id: 666 }, text: "/kill" } }, { token: "T", chatId: "42", fetchFn });
    expect((await service.store.getProposal(rec.id))!.status).toBe("pending");
    expect((await service.killSwitch()).on).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("/approve by id prefix, /kill and /ask without the worker", async () => {
    const { service } = makeService({ env: { DESK_APPROVAL: "manual" } });
    const rec = await service.submitOpen(trade, null);
    const { calls, fetchFn } = recorder();
    const o = { token: "T", chatId: "42", fetchFn };
    await handleTelegramUpdate(service, { update_id: 1, message: { chat: { id: 42 }, text: `/approve ${rec.id.slice(-12)}` } }, o);
    // a suffix is not a prefix: nothing resolves
    expect((await service.store.getProposal(rec.id))!.status).toBe("pending");
    await handleTelegramUpdate(service, { update_id: 2, message: { chat: { id: 42 }, text: `/approve ${rec.id.slice(0, 8)}` } }, o);
    expect((await service.store.getProposal(rec.id))!.status).toBe("executed");
    await handleTelegramUpdate(service, { update_id: 3, message: { chat: { id: 42 }, text: "/kill too volatile" } }, o);
    expect(await service.killSwitch()).toMatchObject({ on: true, reason: "too volatile" });
    await handleTelegramUpdate(service, { update_id: 4, message: { chat: { id: 42 }, text: "/ask is this a trap?" } }, o);
    expect(calls.at(-1)!.body.text).toContain("desk worker");
  });
});

describe("telegram intel (SPEC F0.6)", () => {
  const newAlert = (): NewAlert => ({
    kind: "mapper",
    ref: "cluster-1",
    window: null,
    asset: "SOL",
    title: "SOL exploit",
    eventType: "exploit",
    line: { tag: "hypothesis", text: "Long SOL: exposure via collateral." },
    path: [],
    edgeType: null,
    hops: 0,
    pathWeight: 1,
    sources: [],
    materiality: 0.5,
    pricedIn: null,
    route: "push",
  });
  const brief = (o: Partial<Brief>): Brief => ({ id: "b1", createdAt: "2026-10-14T00:00:00.000Z", surface: "ui", since: "2026-10-13T18:00:00.000Z", items: [], alerts: [], catalysts: [], lines: [], silent: false, ...o });
  const item = { asset: "SOL", metric: "price", held: true, from: 100, to: 104.1, delta: 4.1, deltaUnit: "pct", z: 2.5, materiality: 2.5, exposureWeight: 1, stopProximity: 1, ts: "2026-10-14T00:00:00.000Z", baselineTs: "2026-10-13T18:00:00.000Z" } as const;

  test("fb:<alertId>:<vote> stores the vote, answers the callback and marks the voted button", async () => {
    const { service } = makeService({});
    const store = new MemoryIntelStore();
    const a = (await store.insertAlert(newAlert()))!;
    const { calls, fetchFn } = recorder();
    const keyboard = [feedbackActions([a]).map((x) => ({ text: x.label, callback_data: x.data }))];
    const intel = { store, brief: async () => brief({}) };
    await handleTelegramUpdate(
      service,
      { update_id: 1, callback_query: { id: "cq", data: `fb:${a.id}:-1`, message: { chat: { id: 42 }, message_id: 7, reply_markup: { inline_keyboard: keyboard } } } },
      { token: "T", chatId: "42", fetchFn, intel },
    );
    expect(store.alerts[0]!.feedback).toBe(-1);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);
    expect(calls[1]!.body.reply_markup.inline_keyboard[0]).toEqual([
      { text: "👍", callback_data: `fb:${a.id}:1` },
      { text: "✅ 👎", callback_data: `fb:${a.id}:-1` },
    ]);
    // Another chat: ignored.
    await handleTelegramUpdate(service, { update_id: 2, callback_query: { id: "cq", data: `fb:${a.id}:1`, message: { chat: { id: 666 }, message_id: 7 } } }, { token: "T", chatId: "42", fetchFn, intel });
    expect(store.alerts[0]!.feedback).toBe(-1);
    expect(calls).toHaveLength(2);
  });

  test("/digest builds a telegram_digest brief with a bounded signal and replies with its lines + review link", async () => {
    const { service } = makeService({});
    const { calls, fetchFn } = recorder();
    const seen: Array<{ via: string; signal: AbortSignal }> = [];
    const lines = [{ tag: "hypothesis" as const, text: "Long SOL: the move is large." }];
    const intel = { store: new MemoryIntelStore(), link: "https://app.example.com/?review=1", brief: async (o: { via: "telegram_digest"; signal: AbortSignal }) => (seen.push(o), brief({ lines, items: [item] })) };
    await handleTelegramUpdate(service, { update_id: 1, message: { chat: { id: 42 }, text: "/digest" } }, { token: "T", chatId: "42", fetchFn, intel });
    expect(seen[0]!.via).toBe("telegram_digest");
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls.at(-1)!.body.text).toBe("• [hypothesis] Long SOL: the move is large.\n\nhttps://app.example.com/?review=1");

    // Narration timed out or capped (lines []): the ranked raw-number items go out instead.
    intel.brief = async () => brief({ items: [item], trace: { promptVersion: "v", tier: "strong", model: "m", inputs: {}, output: null, usage: null, ms: 20_000, error: "aborted" } as Brief["trace"] });
    await handleTelegramUpdate(service, { update_id: 2, message: { chat: { id: 42 }, text: "/digest" } }, { token: "T", chatId: "42", fetchFn, intel });
    expect(calls.at(-1)!.body.text).toBe("• held SOL price +4.10% (z +2.50)\n\nhttps://app.example.com/?review=1");

    intel.brief = async () => brief({ silent: true });
    await handleTelegramUpdate(service, { update_id: 3, message: { chat: { id: 42 }, text: "/digest" } }, { token: "T", chatId: "42", fetchFn, intel });
    expect(calls.at(-1)!.body.text).toContain("Nothing cleared");
  });

  test("without Intel deps: /digest says so and fb presses fall through unchanged", async () => {
    const { service } = makeService({});
    const { calls, fetchFn } = recorder();
    await handleTelegramUpdate(service, { update_id: 1, message: { chat: { id: 42 }, text: "/digest" } }, { token: "T", chatId: "42", fetchFn });
    expect(calls.at(-1)!.body.text).toContain("/digest");
    await handleTelegramUpdate(service, { update_id: 2, callback_query: { id: "cq", data: "fb:x:1", message: { chat: { id: 42 }, message_id: 7 } } }, { token: "T", chatId: "42", fetchFn });
    expect(calls.at(-1)!.body.text).toBe("unknown action");
  });
});

describe("notify", () => {
  test("telegram payload escapes HTML and carries inline buttons", () => {
    const p = telegramPayload("42", { level: "warn", title: "a<b", body: "x & y", actions: [{ label: "Approve", data: "approve:1" }] });
    expect(p.text).toContain("a&lt;b");
    expect(p.text).toContain("x &amp; y");
    expect(p.reply_markup!.inline_keyboard[0]![0]).toEqual({ text: "Approve", callback_data: "approve:1" });
    expect(escapeHtml("<>&")).toBe("&lt;&gt;&amp;");
  });

  test("sends to every configured channel and reports which succeeded", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(String(url));
      return new Response("", { status: String(url).includes("discord") ? 500 : 200 });
    }) as unknown as typeof fetch;
    const n = createNotifier({ DESK_TELEGRAM_BOT_TOKEN: "T", DESK_TELEGRAM_CHAT_ID: "1", DESK_DISCORD_WEBHOOK_URL: "https://discord.test/x", DESK_ALERT_WEBHOOK_URL: "https://hook.test" }, fetchFn);
    expect(n.channels).toEqual(["telegram", "discord", "webhook"]);
    expect(await n.send({ level: "info", title: "t", body: "b" })).toEqual(["telegram", "webhook"]);
    expect(urls).toHaveLength(3);
  });
});

describe("watched account", () => {
  test("maps clearinghouse state and reduce-only triggers onto positions", () => {
    const state = {
      marginSummary: { accountValue: "25000.5", totalNtlPos: "8000" },
      assetPositions: [
        { position: { coin: "BTC", szi: "-0.05", entryPx: "101000", positionValue: "5000", unrealizedPnl: "50" } },
        { position: { coin: "ETH", szi: "0.75", entryPx: "3900", positionValue: "3000", unrealizedPnl: "75" } },
      ],
    };
    const orders = [
      { coin: "BTC", isTrigger: true, triggerPx: "104000", orderType: "Stop Market", reduceOnly: true },
      { coin: "ETH", isTrigger: true, triggerPx: "4500", orderType: "Take Profit Market", reduceOnly: true },
    ];
    const acc = toWatchedAccount(state, orders, 24_000);
    expect(acc.equityUsd).toBe(25000.5);
    expect(acc.dayPnlUsd).toBeCloseTo(1000.5, 6);
    expect(acc.positions[0]).toMatchObject({ coin: "BTC", side: "short", size: 0.05, markPx: 100_000, stopPx: 104_000, tpPx: null });
    expect(acc.positions[1]).toMatchObject({ coin: "ETH", side: "long", stopPx: null, tpPx: 4500 });
  });

  test("trimForModel keeps the tail of long arrays", () => {
    expect(trimForModel({ a: Array.from({ length: 40 }, (_, i) => i) }, 3)).toEqual({ a: { omitted: 37, last: [37, 38, 39] } });
    expect(trimForModel([1, 2], 3)).toEqual([1, 2]);
  });
});
