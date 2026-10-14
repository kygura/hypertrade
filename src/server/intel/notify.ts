import type { Claim } from "../../shared/claims.js";
import type { Alert } from "../../shared/intel.js";
import type { AlertAction, Notifier } from "../desk/notify.js";

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

/**
 * 👍/👎 per stored alert (Telegram callback "fb:<alertId>:1|-1", SPEC F0.6),
 * named by asset when one message carries several alerts.
 * ponytail: first 4 alerts only (8 buttons, one keyboard row); more → vote from the Terminal.
 */
export function feedbackActions(alerts: Array<Pick<Alert, "id" | "asset">>): AlertAction[] {
  const many = alerts.length > 1;
  return alerts.slice(0, 4).flatMap((a) => {
    const tag = many ? ` ${a.asset}` : "";
    return [
      { label: `👍${tag}`, data: `fb:${a.id}:1` },
      { label: `👎${tag}`, data: `fb:${a.id}:-1` },
    ];
  });
}

/** Sends one Intel message; returns the channels it reached (empty when none is configured, all failed or the send threw). */
export async function sendIntel(notifier: Notifier, m: { title: string; lines: Array<Claim | string>; link?: string; actions?: AlertAction[] }): Promise<string[]> {
  if (!notifier.channels.length) return [];
  return notifier.send({ level: "info", title: m.title, body: formatIntel(m), ...(m.actions?.length ? { actions: m.actions } : {}) }).catch((err) => {
    console.error("[intel] send failed:", err instanceof Error ? err.message : err);
    return [];
  });
}
