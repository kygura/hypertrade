import { describe, expect, test } from "bun:test";
import { createNotifier, escapeHtml, telegramPayload } from "./notify.js";
import { handleTelegramUpdate } from "./telegram.js";
import { makeService } from "./testkit.js";
import { toWatchedAccount, trimForModel } from "./data.js";

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
