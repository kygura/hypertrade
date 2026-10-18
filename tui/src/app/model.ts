// View-model shapes shared by the controller (app/controller.ts) and the Ink
// components (ui/*). Types only.
import type { Brief } from "../core/brief.js";
import type { Pulse } from "../core/lab.js";
import type { SortKey } from "../commands/parse.js";
import type { AccountSnapshot, Alert, AppState, BookView, CoinView, Network, SendResult, Ticket } from "../core/types.js";

export type Mode = "prompt" | "agent" | "ticket" | "overlay";

export interface BannerInfo {
  network: Network;
  account: string | null;
  canTrade: boolean;
  demo: boolean;
  agentLabel: string | null;
}

export interface HelpItem {
  usage: string;
  summary: string;
}

export type Snapshot =
  | { view: "pos"; data: { account: AccountSnapshot | null; configured: boolean; szDecimals: Record<string, number> } }
  | { view: "coin"; data: CoinView }
  | { view: "alerts"; data: Alert[] }
  | { view: "pulse"; data: Pulse }
  | { view: "brief"; data: Brief }
  | { view: "help"; data: HelpItem[] }
  | { view: "model"; data: { label: string | null; reason?: string } }
  | { view: "book-summary"; data: { book: BookView; szDecimals: number } };

export type ToolStatus = "running" | "ok" | "error" | "aborted";

/** sent / failed / simulated freeze the card; discarded / dismissed print one note line. */
export type TicketOutcome = "sent" | "failed" | "simulated" | "discarded" | "dismissed";
export type TicketSource = "command" | "agent";

/** What the card needs besides the ticket. */
export interface TicketUi {
  phase: "awaiting" | "requoting" | "sending" | "frozen";
  source: TicketSource;
  /** Set after a re-quote that changed the ticket ("changed" state). */
  changedWhy?: string;
  previous?: Ticket;
  outcome?: TicketOutcome;
  /** read-only: no key; demo: sends are simulated. */
  access: "trade" | "read-only" | "demo";
  /** IOC band as a fraction (config.slippage). */
  slippage: number;
  szDecimals: number;
  /** Stop currently resting on the position (for the MOVE STOP headline). */
  oldStopPx?: number | null;
}

export type Entry = { id: string; at: number } & (
  | { kind: "banner"; info: BannerInfo }
  | { kind: "user"; text: string }
  /** `cont`: a later paragraph of the same answer (no ● marker). */
  | { kind: "agent-text"; text: string; cont?: boolean }
  | { kind: "tool-line"; name: string; args: string; status: ToolStatus; ms?: number; error?: string }
  | { kind: "alert"; alert: Alert }
  | ({ kind: "view-snapshot" } & Snapshot)
  | { kind: "ticket"; ticket: Ticket; outcome: TicketOutcome; ui: TicketUi }
  | { kind: "result"; result: SendResult; ticketId: string; demo: boolean }
  | { kind: "error"; source: string; message: string; hint?: string }
  | { kind: "note"; text: string }
);

export type EntryKind = Entry["kind"];

export interface RunningTool {
  name: string;
  args: string;
  startedAt: number;
}

export interface AgentRun {
  startedAt: number;
  /** Current (unfinished) paragraph. */
  text: string;
  /** True once a paragraph of this answer was flushed (next one prints without ●). */
  flushed: boolean;
  tools: RunningTool[];
}

export interface PendingTicket {
  ticket: Ticket;
  ui: TicketUi;
}

export type SortDir = "desc" | "asc";

export interface MarketsOverlay {
  kind: "markets";
  sort: SortKey;
  dir: SortDir;
  filter: string;
  selected: number;
  /** Filter being edited in the footer; null when not editing. */
  editing: string | null;
}

export interface BookOverlay {
  kind: "book";
  coin: string;
  levels: number;
  book: BookView | null;
  error: string | null;
  /** Markets overlay to return to on Esc (opened with `b`). */
  back: MarketsOverlay | null;
}

export type Overlay = MarketsOverlay | BookOverlay;

export interface Completion {
  items: Array<{ label: string; detail: string }>;
  selected: number;
  /** Input before the token being completed. */
  head: string;
}

export interface View {
  state: AppState;
  entries: Entry[];
  mode: Mode;
  quitArmed: boolean;
  input: string;
  cursor: number;
  completion: Completion | null;
  agentRun: AgentRun | null;
  /** Live one-liner while something loads ("quoting…", "fetching BTC book…"). */
  busy: string | null;
  pending: PendingTicket | null;
  overlay: Overlay | null;
  /** Model label, or null when the agent is off. */
  agentLabel: string | null;
}

/** Ink's Key, the fields the controller reads. */
export interface KeyLike {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
}
