// Desk worker: the desk's always-on loop for a machine that can keep a
// process alive (a VPS, Fly, Railway, a home server). Vercel cannot, so on
// Vercel alone the desk ticks every 15 minutes from collect.yml instead.
//
//   bun run desk:worker
//
// - runs the watch tick every DESK_WORKER_TICK_SEC (default 60): stops,
//   triggers, alerts, and agent cycles within the configured caps
// - long-polls Telegram for commands and Approve/Reject presses when a bot is
//   configured without a webhook, including /ask (a full team run)
//
// Needs the same env as the app (DATABASE_URL, a model key, DESK_*).
import { deskProviderFactory, runDesk } from "../src/server/desk/agents.js";
import { telegramApi } from "../src/server/desk/notify.js";
import { handleTelegramUpdate, type TelegramUpdate } from "../src/server/desk/telegram.js";
import { tick } from "../src/server/desk/watch.js";
import { defaultDeskService } from "../src/server/routes/desk.js";

const service = defaultDeskService();
const makeProvider = deskProviderFactory();
const tickMs = Math.max(30, Number(process.env.DESK_WORKER_TICK_SEC ?? 60) || 60) * 1000;
let stopping = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[desk]", ...a);

async function tickLoop() {
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await tick(service, { makeProvider, cycleTimeoutMs: 600_000 });
      const parts = [
        r.triggers.length ? `triggers: ${r.triggers.map((t) => t.key).join(", ")}` : null,
        r.settled.length ? `settled: ${r.settled.map((s) => `${s.coin} ${s.kind} ${s.pnl.toFixed(2)}`).join(", ")}` : null,
        r.expired ? `expired ${r.expired}` : null,
        r.cycle ? ("runId" in r.cycle ? `cycle ${r.cycle.runId} (${r.cycle.stop})` : `cycle skipped: ${r.cycle.skipped}`) : null,
      ].filter(Boolean);
      if (parts.length) log(parts.join(" · "));
    } catch (err) {
      log("tick failed:", err instanceof Error ? err.message : err);
    }
    await sleep(Math.max(1000, tickMs - (Date.now() - started)));
  }
}

async function telegramLoop(token: string, chatId: string) {
  const KEY = "telegram_offset";
  let offset = (await service.store.getState<number>(KEY)) ?? 0;
  const ask = async (question: string) => {
    const r = await runDesk({ service, kind: "ask", input: question, act: false, makeProvider, timeoutMs: 600_000 }, () => {});
    return r.answer || "(no answer)";
  };
  log("telegram: polling");
  while (!stopping) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message", "callback_query"] }),
        signal: AbortSignal.timeout(35_000),
      });
      const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
      for (const u of body.result ?? []) {
        offset = u.update_id + 1;
        await service.store.setState(KEY, offset);
        // /ask can take minutes; do not block the next updates on it.
        void handleTelegramUpdate(service, u, { token, chatId, ask }).catch((err) => log("telegram update failed:", err));
      }
    } catch (err) {
      log("telegram poll failed:", err instanceof Error ? err.message : err);
      await sleep(5000);
    }
  }
}

async function main() {
  const pm = makeProvider("pm");
  log(`starting: venue ${service.broker.venue}, approval ${await service.approval()}, model ${pm ? `${pm.id}/${pm.model}` : "none (alerts only)"}, tick ${tickMs / 1000}s`);
  const token = process.env.DESK_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.DESK_TELEGRAM_CHAT_ID?.trim();
  const loops = [tickLoop()];
  if (token && chatId && !process.env.DESK_TELEGRAM_WEBHOOK_SECRET) {
    // Polling and a webhook cannot coexist on one bot.
    await telegramApi(token, "deleteWebhook", {}).catch(() => undefined);
    loops.push(telegramLoop(token, chatId));
  }
  await Promise.all(loops);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig}: finishing the current step`);
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

void main();
