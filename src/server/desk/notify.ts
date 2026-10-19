import type { AlertLevel } from "./types.js";

// Alert delivery. Every alert is stored (desk_alerts) by the caller; this
// module only pushes it out to whichever channels are configured:
//   Telegram  DESK_TELEGRAM_BOT_TOKEN + DESK_TELEGRAM_CHAT_ID (inline approve/reject buttons)
//   Discord   DESK_DISCORD_WEBHOOK_URL
//   Webhook   DESK_ALERT_WEBHOOK_URL (POST JSON {level, title, body, actions, ts})
//   ntfy      NTFY_TOPIC (NTFY_SERVER defaults to https://ntfy.sh; NTFY_TOKEN optional)
// A channel failing never fails the caller: the result lists what went out.

export interface AlertAction {
  label: string;
  /** Telegram callback data, e.g. "approve:<proposal id>". */
  data: string;
}

export interface Alert {
  level: AlertLevel;
  title: string;
  body: string;
  actions?: AlertAction[];
  /** Link opened when an ntfy notification is tapped. */
  click?: string;
}

export interface Notifier {
  send(a: Alert): Promise<string[]>;
  readonly channels: string[];
}

type Env = Record<string, string | undefined>;

const ICON: Record<AlertLevel, string> = { info: "🔹", warn: "🟠", critical: "🔴" };
const NTFY_PRIORITY: Record<AlertLevel, string> = { info: "3", warn: "4", critical: "5" };
/** HTTP header values must be printable ASCII; fetch throws on anything else. */
const asciiHeader = (s: string) => s.replace(/[^\x20-\x7e]/g, "").slice(0, 250);

/** Telegram HTML needs only &, <, > escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function telegramPayload(chatId: string, a: Alert) {
  const text = `${ICON[a.level]} <b>${escapeHtml(a.title)}</b>\n\n${escapeHtml(a.body)}`.slice(0, 4000);
  return {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(a.actions?.length ? { reply_markup: { inline_keyboard: [a.actions.map((x) => ({ text: x.label, callback_data: x.data.slice(0, 64) }))] } } : {}),
  };
}

export function telegramApi(token: string, method: string, body: unknown, fetchFn: typeof fetch = fetch) {
  return fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

export function createNotifier(
  env: Env = process.env,
  fetchFn: typeof fetch = fetch,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Notifier {
  const tgToken = env.DESK_TELEGRAM_BOT_TOKEN?.trim();
  const tgChat = env.DESK_TELEGRAM_CHAT_ID?.trim();
  const discord = env.DESK_DISCORD_WEBHOOK_URL?.trim();
  const hook = env.DESK_ALERT_WEBHOOK_URL?.trim();
  const ntfy = env.NTFY_TOPIC?.trim();
  const ntfyServer = env.NTFY_SERVER?.trim() || "https://ntfy.sh";
  const ntfyToken = env.NTFY_TOKEN?.trim();
  const channels = [tgToken && tgChat ? "telegram" : null, discord ? "discord" : null, hook ? "webhook" : null, ntfy ? "ntfy" : null].filter((x): x is string => !!x);

  const post = async (name: string, f: () => Promise<Response>) => {
    try {
      const r = await f();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return name;
    } catch (err) {
      console.error(`[desk] alert via ${name} failed:`, err instanceof Error ? err.message : err);
      return null;
    }
  };

  return {
    channels,
    async send(a) {
      const jobs: Array<Promise<string | null>> = [];
      if (tgToken && tgChat) jobs.push(post("telegram", () => telegramApi(tgToken, "sendMessage", telegramPayload(tgChat, a), fetchFn)));
      if (discord) {
        const content = `${ICON[a.level]} **${a.title}**\n${a.body}${a.actions?.length ? `\n_${a.actions.map((x) => x.label).join(" · ")} from the Desk page_` : ""}`.slice(0, 1990);
        jobs.push(
          post("discord", () =>
            fetchFn(discord, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(10_000) }),
          ),
        );
      }
      if (hook) {
        jobs.push(
          post("webhook", () =>
            fetchFn(hook, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...a, ts: new Date().toISOString(), source: "hypertrade-desk" }),
              signal: AbortSignal.timeout(10_000),
            }),
          ),
        );
      }
      if (ntfy) {
        jobs.push(
          post("ntfy", async () => {
            const send = () =>
              fetchFn(`${ntfyServer.replace(/\/+$/, "")}/${encodeURIComponent(ntfy)}`, {
              method: "POST",
              headers: {
                Title: asciiHeader(a.title),
                Priority: NTFY_PRIORITY[a.level],
                ...(a.click ? { Click: asciiHeader(a.click) } : {}),
                ...(ntfyToken ? { Authorization: `Bearer ${ntfyToken}` } : {}),
              },
              body: a.body.slice(0, 4000),
              signal: AbortSignal.timeout(10_000),
              });
            const r = await send();
            if (r.status !== 429) return r;
            // Rate limited (shared egress IPs): retry the same message once after Retry-After.
            const wait = Number(r.headers.get("retry-after"));
            await sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait : 10, 30) * 1000);
            return send();
          }),
        );
      }
      return (await Promise.all(jobs)).filter((x): x is string => !!x);
    },
  };
}
