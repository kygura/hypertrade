import type { Notifier } from "../desk/notify.js";
import type { Bus } from "./bus.js";
import type { LoopDef } from "./runtime.js";
import { envNum } from "./scanner.js";

// Telegram alerts through the desk notifier (SPEC P0.15, P0.16):
//  - an opportunity reaches `ready` with score >= PLATFORM_PUSH_SCORE: once per opportunity
//  - the WS feed goes silent for > 30 s: once; recovery: once
// Links point at the cockpit `/`. A failing channel never throws out of here.

export const WS_SILENT_SEC = 30;

export function createAlerts(deps: {
  notifier: Pick<Notifier, "send">;
  /** Seconds since the last WS message, null before the first. */
  wsAgeSec: () => number | null;
  appUrl?: string;
  pushScore?: number;
}) {
  const pushScore = deps.pushScore ?? envNum("PLATFORM_PUSH_SCORE", 3);
  const link = deps.appUrl ? `\n\n${deps.appUrl.replace(/\/+$/, "")}/` : "";
  const pushed = new Set<string>();
  let silent = false;
  const send = (level: "info" | "warn" | "critical", title: string, body: string) =>
    deps.notifier.send({ level, title, body: body + link }).catch((err) => console.error("[alerts]", err instanceof Error ? err.message : err));

  /** One WS silence check. Fires once on silence and once on recovery. */
  const check = async () => {
    const age = deps.wsAgeSec();
    if (age == null) return;
    if (!silent && age > WS_SILENT_SEC) {
      silent = true;
      await send("critical", "Hyperliquid feed silent", `No WS message for ${age.toFixed(0)} s. Prices and the freshness gate are stale.`);
    } else if (silent && age <= WS_SILENT_SEC) {
      silent = false;
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
