import type { Claim } from "../../shared/claims.js";
import type { Notifier } from "../desk/notify.js";

// Intel pushes go out through the Desk notifier (createNotifier), so they
// reach the same Telegram chat / Discord / webhook as Desk alerts and inherit
// its "a channel failing never fails the caller" rule. Formatting only here.

export const MAX_LINES = 5;

/** One bullet per line: observed facts name their source, hypotheses are marked as inference. */
export function formatIntel(m: { lines: Array<Claim | string>; link?: string }): string {
  const bullets = m.lines.slice(0, MAX_LINES).map((l) => {
    if (typeof l === "string") return `• ${l}`;
    return l.tag === "observed" ? `• ${l.text} (${l.source.label})` : `• [hypothesis] ${l.text}`;
  });
  return [...bullets, ...(m.link ? ["", m.link] : [])].join("\n");
}

/** Sends one Intel message; returns the channels it reached (empty when none is configured or all failed). */
export async function sendIntel(notifier: Notifier, m: { title: string; lines: Array<Claim | string>; link?: string }): Promise<string[]> {
  if (!notifier.channels.length) return [];
  return notifier.send({ level: "info", title: m.title, body: formatIntel(m) });
}
