// The live region below the transcript (DESIGN.md §1.1, §1.2): active area →
// completion list → position strip (medium) → rule + prompt → hints → status bar.
// Never taller than rows − 1.
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { AgentRun, Completion, Mode } from "../app/model.js";
import type { AppState } from "../core/types.js";
import { padEnd, wrapText } from "./format.js";
import { ToolLine } from "./lines.js";
import { PositionsMini, PositionStrip } from "./Positions.js";
import { StatusBar } from "./StatusBar.js";
import { g, tone } from "./theme.js";

export type Tier = "narrow" | "medium" | "wide";

export const MIN_COLS = 80;
export const MIN_ROWS = 20;
export const MINI_WIDTH = 42;

export function tierOf(cols: number, rows: number): Tier {
  if (cols >= 160 && rows >= 30) return "wide";
  if (cols >= 100) return "medium";
  return "narrow";
}

/** Prose wraps at min(cols − 4, 110); at wide tier also ≤ cols − 44 (lines up with the dock's left column). */
export function proseWidth(cols: number, rows: number): number {
  const w = Math.min(cols - 4, 110);
  return tierOf(cols, rows) === "wide" ? Math.min(w, cols - 44) : w;
}

export interface PromptProps {
  value: string;
  cursor: number;
  disabled: boolean;
  disabledText: string;
  width: number;
}

export function Prompt({ value, cursor, disabled, disabledText, width }: PromptProps) {
  const c = Math.max(0, Math.min(cursor, value.length));
  return (
    <Box flexDirection="column">
      <Text {...tone("dim")}>{g().rule.repeat(Math.max(1, width))}</Text>
      {disabled ? (
        <Text>
          <Text {...tone("accent")}>{g().prompt} </Text>
          <Text {...tone("dim")}>{disabledText}</Text>
        </Text>
      ) : (
        <Text>
          <Text {...tone("accent")}>{g().prompt} </Text>
          {value.slice(0, c)}
          <Text inverse>{value[c] ?? " "}</Text>
          {value.slice(c + 1)}
        </Text>
      )}
    </Box>
  );
}

export interface HintsProps {
  mode: Mode;
  width: number;
  quitArmed: boolean;
  agentElapsedS: number;
  completionOpen?: boolean;
  /** Ticket can only be dismissed (blocked / read-only). */
  ticketDismissOnly?: boolean;
}

export function hintText(p: HintsProps): string {
  if (p.quitArmed) return "press ctrl-c again to quit";
  if (p.completionOpen) return "tab/↑↓ select · enter accept · esc close";
  switch (p.mode) {
    case "agent":
      return `agent running ${p.agentElapsedS}s · esc abort`;
    case "ticket":
      return p.ticketDismissOnly ? "n/esc dismiss" : "y send · n/esc discard";
    case "overlay":
      return "esc close";
    default:
      return "enter send · ↑↓ history · tab complete · / commands · ctrl-c ×2 quit";
  }
}

export function Hints(p: HintsProps) {
  return (
    <Text {...tone(p.quitArmed ? "warn" : "dim")} wrap="truncate-end">
      {"  "}
      {hintText(p)}
    </Text>
  );
}

export function CompletionList({ items, selected, maxRows = 6 }: { items: Completion["items"]; selected: number; maxRows?: number }) {
  const start = Math.max(0, Math.min(items.length - maxRows, selected - Math.floor(maxRows / 2)));
  const shown = items.slice(start, start + maxRows);
  const w = Math.max(...shown.map((i) => i.label.length)) + 2;
  return (
    <Box flexDirection="column">
      {shown.map((it, i) => {
        const sel = start + i === selected;
        return (
          <Text key={it.label} wrap="truncate-end">
            <Text {...(sel ? { ...tone("accent"), bold: true } : {})}>
              {sel ? `${g().tool} ` : "  "}
              {padEnd(it.label, w)}
            </Text>
            <Text {...tone("dim")}>{it.detail}</Text>
          </Text>
        );
      })}
      {items.length > maxRows && <Text {...tone("dim")}>  {items.length} matches</Text>}
    </Box>
  );
}

/** Streaming paragraph (last `maxLines` lines) + running tool lines, or the thinking line. */
export function AgentLive({ run, width, maxLines, now }: { run: AgentRun; width: number; maxLines: number; now: number }) {
  const elapsed = Math.max(0, Math.floor((now - run.startedAt) / 1000));
  const text = run.text.trim();
  const lines = text ? wrapText(text, Math.max(10, width - 2), 0) : [];
  const shown = lines.slice(-Math.max(1, maxLines - run.tools.length));
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => (
        <Text key={i}>
          <Text {...tone("accent")}>{i === 0 && lines.length === shown.length && !run.flushed ? g().bullet : " "} </Text>
          {l}
        </Text>
      ))}
      {run.tools.map((t, i) => (
        <ToolLine key={`t${i}`} name={t.name} args={t.args} status="running" />
      ))}
      {!text && !run.tools.length && (
        <Text>
          <Text {...tone("accent")}>{g().bullet} </Text>
          <Text {...tone("dim")}>thinking {elapsed}s · esc abort</Text>
        </Text>
      )}
    </Box>
  );
}

export interface DockProps {
  mode: Mode;
  /** Active area (agent stream, busy line, ticket card); already clipped to `activeMax`. */
  active: ReactNode;
  /** Overlay content replaces active area, prompt, hints, strip and side panel. */
  overlay: ReactNode | null;
  state: AppState;
  prompt: PromptProps;
  hints: HintsProps;
  completion: Completion | null;
  agentLabel: string | null;
  width: number;
  rows: number;
  now: number;
}

/** Lines the dock uses besides the active area (so callers can size it). */
export function dockChrome(state: AppState, cols: number, rows: number, completion: Completion | null): number {
  const tier = tierOf(cols, rows);
  const strip = tier === "medium" && (state.account?.positions.length ?? 0) > 0 ? 1 : 0;
  const comp = completion ? Math.min(6, completion.items.length) + (completion.items.length > 6 ? 1 : 0) : 0;
  return 1 /* status */ + 1 /* hints */ + 2 /* rule + prompt */ + strip + comp;
}

export function Dock({ active, overlay, state, prompt, hints, completion, agentLabel, width, rows, now }: DockProps) {
  if (width < MIN_COLS || rows < MIN_ROWS) {
    return (
      <Text>
        ht needs {MIN_COLS}×{MIN_ROWS} (now {width}×{rows})
      </Text>
    );
  }
  const status = <StatusBar state={state} agentLabel={agentLabel} width={width} now={now} />;
  if (overlay) {
    return (
      <Box flexDirection="column" width={width}>
        {overlay}
        {status}
      </Box>
    );
  }
  const tier = tierOf(width, rows);
  const leftW = tier === "wide" ? width - MINI_WIDTH - 1 : width;
  const left = (
    <Box flexDirection="column" width={leftW} justifyContent="flex-end">
      {active}
      {completion && <CompletionList items={completion.items} selected={completion.selected} />}
      {tier === "medium" && state.account && <PositionStrip positions={state.account.positions} width={width} />}
      <Prompt {...prompt} width={leftW} />
      <Hints {...hints} width={leftW} />
    </Box>
  );
  return (
    <Box flexDirection="column" width={width}>
      {tier === "wide" ? (
        <Box flexDirection="row">
          {left}
          <Box width={MINI_WIDTH + 1} borderStyle={g().rule === "-" ? "classic" : "single"} borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1} flexDirection="column">
            <PositionsMini account={state.account} maxRows={9} />
          </Box>
        </Box>
      ) : (
        left
      )}
      {status}
    </Box>
  );
}
