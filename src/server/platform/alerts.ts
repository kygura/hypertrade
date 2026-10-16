import type { Notifier } from "../desk/notify.js";
import type { Bus } from "./bus.js";
import type { LoopDef } from "./runtime.js";
import { envNum } from "./scanner.js";

// Telegram alerts through the desk notifier (SPEC P0.15, P0.16):
//  - an opportunity reaches `ready` with score >= PLATFORM_PUSH_SCORE: once per opportunity
//  - the WS feed goes silent for > 30 s (or never delivers a message in the first 60 s): once;
//    recovery after 2 consecutive ok checks: once; "silent" alerts are at least 10 min apart
// Links point at the cockpit `/`. A failing channel never throws out of here.

export const WS_SILENT_SEC = 30;
const NEVER_CONNECTED_MS = 60_000;
const SILENT_COOLDOWN_MS = 600_000;
const RECOVERY_CHECKS = 2;

export function createAlerts(deps: {
  notifier: Pick<Notifier, "send">;
  /** Seconds since the last WS message, null before the first. */
  wsAgeSec: () => number | null;
  appUrl?: string;
  pushScore?: number;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const pushScore = deps.pushScore ?? envNum("PLATFORM_PUSH_SCORE", 3);
  const link = deps.appUrl ? `\n\n${deps.appUrl.replace(/\/+$/, "")}/` : "";
  const pushed = new Set<string>();
  let silent = false;
  let okStreak = 0;
  let lastSilentAt = -Infinity;
  const send = (level: "info" | "warn" | "critical", title: string, body: string) =>
    deps.notifier.send({ level, title, body: body + link }).catch((err) => console.error("[alerts]", err instanceof Error ? err.message : err));

  /** One WS silence check. Fires on silence (cooldown-limited) and once on recovery. */
  const check = async () => {
    const age = deps.wsAgeSec();
    const t = now();
    const quiet = (title: string, body: string) => {
      okStreak = 0;
      if (silent || t - lastSilentAt < SILENT_COOLDOWN_MS) return;
      silent = true;
      lastSilentAt = t;
      return send("critical", title, body);
    };
    if (age == null) {
      if (t - startedAt > NEVER_CONNECTED_MS) await quiet("Hyperliquid feed never connected", "No WS message since boot. Prices and the freshness gate are stale.");
    } else if (age > WS_SILENT_SEC) {
      await quiet("Hyperliquid feed silent", `No WS message for ${age.toFixed(0)} s. Prices and the freshness gate are stale.`);
    } else if (silent && ++okStreak >= RECOVERY_CHECKS) {
      silent = false;
      okStreak = 0;
      await send("info", "Hyperliquid feed recovered", "WS messages are flowing again.");
    }
  };

  return {
    /** Wire the ready-opportunity push; returns the unsubscribe. */
    subscribe(bus: Pick<Bus, "subscribe">) {
      return bus.subscribe("opportunity", ({ opportunity: o, change }) => {
        if (change !== "status" || o.status !== "ready" || o.score < pushScore || pushed.has(o.id)) return;
        pushed.add(o.id);
        const edge = o.netEdgeBps == null ? "edge n/a" : `net edge ${o.netEdgeBps.toFixed(0)} bps (${o.edgeBasis})`;
        void send("info", `Ready: ${o.direction} ${o.coin}`, `${o.setupKind}, score ${o.score.toFixed(2)}, ${edge}`);
      });
    },
    check,
    def: { name: "alerts", intervalSec: 10, run: check } satisfies LoopDef,
  };
}
