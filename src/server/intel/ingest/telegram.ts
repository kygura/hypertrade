import type { NewEvent } from "../store.js";
import { fetchText, fresh, headlineEvent, message, pastIso, plain, type AdapterResult, type IngestDeps } from "./common.js";

// Telegram public channels (SPEC.md § Intel I0.10) via the t.me/s/<channel>
// web preview, regex-scraped. Behind INTEL_TG_CHANNELS (comma list). Vercel
// IPs are often refused: a failure is recorded, never retried.

const CHANNEL = /^[A-Za-z][A-Za-z0-9_]{3,63}$/;

export function tgChannels(env: Record<string, string | undefined>): string[] {
  return (env.INTEL_TG_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, ""))
    .filter((s) => CHANNEL.test(s));
}

/** Pure: t.me/s/<channel> HTML → events (one per message with text). */
export function parseTelegramChannel(html: string, channel: string, now: Date): NewEvent[] {
  const out: NewEvent[] = [];
  for (const block of html.split(/(?=<div class="tgme_widget_message_wrap)/).slice(1)) {
    const post = /data-post="([A-Za-z0-9_]+\/\d+)"/.exec(block)?.[1];
    const raw = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1];
    if (!post || !raw) continue;
    const text = plain(raw, 600);
    if (!text) continue;
    const firstSeen = pastIso(/<time[^>]*datetime="([^"]+)"/.exec(block)?.[1], now) ?? now.toISOString();
    if (!fresh(firstSeen, now)) continue;
    out.push(
      headlineEvent({
        key: `tg:${post}`,
        title: text.slice(0, 280),
        summary: text.length > 280 ? text : null,
        url: `https://t.me/${post}`,
        label: `Telegram @${channel}`.slice(0, 120),
        origin: "telegram",
        firstSeen,
      }),
    );
  }
  return out;
}

export async function fetchTelegram(deps: Pick<IngestDeps, "fetch" | "env" | "now" | "signal">): Promise<AdapterResult> {
  const channels = tgChannels(deps.env);
  if (!channels.length) return { source: "telegram", ok: true, items: [], error: "skipped:no-channels" };
  const now = deps.now();
  const items: NewEvent[] = [];
  const failures: string[] = [];
  await Promise.all(
    channels.map(async (ch) => {
      try {
        const html = await fetchText(deps.fetch, `https://t.me/s/${ch}`, { headers: { accept: "text/html" } }, deps.signal);
        const parsed = parseTelegramChannel(html, ch, now);
        // A refused or bot-walled request often comes back 200 with no messages at all.
        if (!parsed.length && !html.includes("tgme_widget_message")) throw new Error("no messages in page (blocked?)");
        items.push(...parsed);
      } catch (e) {
        failures.push(`${ch}: ${message(e)}`);
      }
    }),
  );
  return failures.length ? { source: "telegram", ok: false, items, error: failures.join("; ").slice(0, 500) } : { source: "telegram", ok: true, items };
}
