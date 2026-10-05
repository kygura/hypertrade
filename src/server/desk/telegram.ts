import { telegramApi } from "./notify.js";
import { DeskError, fmtPx, type DeskService } from "./service.js";

// Telegram control: inline Approve/Reject buttons on approval alerts, plus
// a few commands. Updates arrive either by webhook (POST /api/desk/telegram,
// verified by Telegram's secret-token header) or by long polling in
// scripts/desk-worker.ts. Only DESK_TELEGRAM_CHAT_ID is obeyed.
//
//   /status            book, kill switch, approval mode
//   /pending           proposals waiting for approval
//   /approve <id>      /reject <id>
//   /kill [reason]     /resume
//   /ask <question>    worker only (a full run outlives a webhook request)

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number | string }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number | string }; message_id: number } };
}

export interface TelegramOptions {
  token: string;
  chatId: string;
  fetchFn?: typeof fetch;
  /** Present only where a long run is possible (the worker). */
  ask?: (question: string) => Promise<string>;
}

const shortId = (id: string) => id.slice(0, 8);

async function resolveId(service: DeskService, prefix: string): Promise<string | null> {
  const p = prefix.trim().toLowerCase();
  if (p.length < 4) return null;
  const pending = await service.store.listProposals({ status: "pending", limit: 50 });
  const hit = pending.filter((x) => x.id.startsWith(p));
  return hit.length === 1 ? hit[0]!.id : null;
}

export async function handleTelegramUpdate(service: DeskService, u: TelegramUpdate, o: TelegramOptions): Promise<void> {
  const send = (text: string) => telegramApi(o.token, "sendMessage", { chat_id: o.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }, o.fetchFn).catch(() => undefined);

  if (u.callback_query) {
    const cq = u.callback_query;
    if (String(cq.message?.chat.id) !== o.chatId) return;
    const [verb, id] = (cq.data ?? "").split(":");
    let reply = "unknown action";
    if ((verb === "approve" || verb === "reject") && id) {
      try {
        const rec = verb === "approve" ? await service.approve(id, "telegram") : await service.reject(id, "telegram");
        reply = `${verb === "approve" ? "Approved" : "Rejected"} → ${rec.status}`;
      } catch (err) {
        reply = err instanceof DeskError ? err.message : "failed";
      }
    }
    await telegramApi(o.token, "answerCallbackQuery", { callback_query_id: cq.id, text: reply.slice(0, 190) }, o.fetchFn).catch(() => undefined);
    if (cq.message) {
      await telegramApi(o.token, "editMessageReplyMarkup", { chat_id: o.chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }, o.fetchFn).catch(() => undefined);
    }
    await send(reply);
    return;
  }

  const msg = u.message;
  if (!msg?.text || String(msg.chat.id) !== o.chatId) return;
  const [cmdRaw, ...rest] = msg.text.trim().split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase().replace(/@.*$/, "");
  const arg = rest.join(" ");

  switch (cmd) {
    case "/status": {
      const [acc, kill, approval] = await Promise.all([service.account(), service.killSwitch(), service.approval()]);
      const lines = [
        `Equity $${acc.equityUsd.toFixed(2)} · day ${acc.dayPnlUsd >= 0 ? "+" : ""}${acc.dayPnlUsd.toFixed(2)} (${service.broker.venue})`,
        `Kill switch ${kill.on ? "ON" : "off"} · approval ${approval}`,
        ...acc.positions.map((p) => `${p.side} ${p.size} ${p.coin} @ ${fmtPx(p.entryPx)} → ${fmtPx(p.markPx)} · stop ${p.stopPx == null ? "none" : fmtPx(p.stopPx)} · uPnL ${p.unrealizedPnl.toFixed(2)}`),
      ];
      await send(lines.join("\n"));
      return;
    }
    case "/pending": {
      const list = await service.store.listProposals({ status: "pending", limit: 10 });
      await send(list.length ? list.map((p) => `${shortId(p.id)} ${p.kind} ${JSON.stringify(p.proposal).slice(0, 120)}`).join("\n") : "nothing pending");
      return;
    }
    case "/approve":
    case "/reject": {
      const id = await resolveId(service, arg);
      if (!id) return void (await send("give the id (or its first 8 characters) of one pending proposal"));
      try {
        const rec = cmd === "/approve" ? await service.approve(id, "telegram") : await service.reject(id, "telegram");
        await send(`${shortId(id)} → ${rec.status}`);
      } catch (err) {
        await send(err instanceof DeskError ? err.message : "failed");
      }
      return;
    }
    case "/kill":
      await service.setKillSwitch(true, arg || "from Telegram", "telegram");
      return;
    case "/resume":
      await service.setKillSwitch(false, arg || "from Telegram", "telegram");
      return;
    case "/ask": {
      if (!o.ask) return void (await send("/ask works with the desk worker running (scripts/desk-worker.ts); use the Desk page meanwhile"));
      if (!arg) return void (await send("usage: /ask <question>"));
      await send("On it. The team is working…");
      const answer = await o.ask(arg).catch((err) => `failed: ${err instanceof Error ? err.message : String(err)}`);
      for (let i = 0; i < answer.length; i += 3900) await send(answer.slice(i, i + 3900));
      return;
    }
    default:
      await send("commands: /status /pending /approve <id> /reject <id> /kill [reason] /resume /ask <question>");
  }
}
