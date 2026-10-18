// Root component: subscribes to the controller, routes every key to it, and lays
// out Transcript (Static) + Dock (live). All state lives in app/controller.ts.
import { Box, Text, useInput, useStdin, useWindowSize } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Controller } from "../app/controller.js";
import { overlayHeight } from "../app/model.js";
import { findMarket } from "../core/ticket.js";
import { BookOverlay } from "./Book.js";
import { AgentLive, Dock, dockChrome, proseWidth } from "./Dock.js";
import { MarketsOverlay } from "./Markets.js";
import { TicketCard } from "./Ticket.js";
import { Transcript } from "./Transcript.js";
import { tone } from "./theme.js";

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(h);
  }, [ms]);
  return now;
}

export interface AppProps {
  controller: Controller;
  /** Fixed size (tests); default: the terminal's, tracking resizes. */
  columns?: number;
  rows?: number;
}

export function App({ controller, columns, rows }: AppProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getView, controller.getView);
  const win = useWindowSize();
  const cols = columns ?? win.columns ?? 100;
  const rws = rows ?? win.rows ?? 30;
  const now = useNow(1000);

  useEffect(() => controller.resize(cols, rws), [controller, cols, rws]);
  // Without a TTY on stdin (piped, /dev/null) Ink cannot read keys: render only.
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      void controller.key(input, key);
    },
    { isActive: isRawModeSupported },
  );

  const prose = proseWidth(cols, rws);
  const p = view.pending;
  const dismissOnly = !!p && p.ui.access !== "demo" && (p.ui.access === "read-only" || !p.ticket.canSend);

  const overlayH = overlayHeight(rws);
  let overlay = null;
  if (view.overlay?.kind === "markets") overlay = <MarketsOverlay state={view.state} overlay={view.overlay} maxHeight={overlayH} width={cols} now={now} />;
  else if (view.overlay?.kind === "book") {
    const sz = findMarket(view.state.markets, view.overlay.coin)?.szDecimals ?? 2;
    overlay = <BookOverlay overlay={view.overlay} szDecimals={sz} maxHeight={overlayH} width={cols} now={now} />;
  }

  const activeMax = Math.max(1, rws - 1 - dockChrome(view.state, cols, rws, view.completion));
  const agentMax = p ? Math.min(3, activeMax) : activeMax;
  const agentLines = view.agentRun ? Math.min(agentMax, Math.max(1, rws - 8)) : 0;
  const active = (
    <Box flexDirection="column">
      {view.agentRun && <AgentLive run={view.agentRun} width={prose} maxLines={agentLines} now={now} />}
      {view.busy && <Text {...tone("dim")}>{view.busy}</Text>}
      {p && <TicketCard ticket={p.ticket} ui={p.ui} width={cols} maxHeight={Math.max(6, activeMax - (view.agentRun ? agentLines + view.agentRun.tools.length : 0) - (view.busy ? 1 : 0))} />}
    </Box>
  );

  return (
    <>
      <Transcript entries={view.entries} width={cols} prose={prose} />
      <Dock
        mode={view.mode}
        active={active}
        overlay={overlay}
        state={view.state}
        prompt={{
          value: view.input,
          cursor: view.cursor,
          disabled: view.mode === "ticket",
          disabledText: dismissOnly ? "ticket pending: n/esc dismiss" : "ticket pending: y send · n discard",
          width: cols,
        }}
        hints={{
          mode: view.mode,
          width: cols,
          quitArmed: view.quitArmed,
          agentElapsedS: view.agentRun ? Math.max(0, Math.floor((now - view.agentRun.startedAt) / 1000)) : 0,
          completionOpen: !!view.completion,
          ticketDismissOnly: dismissOnly,
        }}
        completion={view.completion}
        agentLabel={view.agentLabel}
        width={cols}
        rows={rws}
        now={now}
      />
    </>
  );
}
