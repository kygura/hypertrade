// Status bar (DESIGN.md §1.3): always the last line. Fields in table order; when
// too wide, the lowest-priority remaining field is dropped (never ellipsized).
import type { AppState } from "../core/types.js";
import { fmtAge, fmtUsd, shortAddr } from "./format.js";
import { marginPct } from "./Positions.js";
import { lineWidth, SegLine, type Line } from "./segs.js";
import { signTone, type Tone } from "./theme.js";

interface Field {
  id: string;
  /** Lower = kept longer. */
  priority: number;
  line: Line;
}

const one = (text: string, t?: Tone): Line => [{ text, ...(t ? { tone: t } : {}) }];

export function statusFields(state: AppState, agentLabel: string | null, width: number, now: number): Field[] {
  const c = state.config;
  const a = state.account;
  const narrow = width < 100;
  const f: Field[] = [];
  if (c.demo) f.push({ id: "demo", priority: 1, line: one(" DEMO ", "badgeDemo") });
  f.push({ id: "network", priority: 0, line: c.network === "mainnet" ? one(" MAINNET ", "badgeMainnet") : one(" TESTNET ", "badgeTestnet") });

  if (!c.account) f.push({ id: "account", priority: 8, line: one("no account", "dim") });
  else if (state.accountError) f.push({ id: "account", priority: 8, line: one("acct err", "critical") });
  else f.push({ id: "account", priority: 8, line: one(shortAddr(c.account)) });

  if (state.marketsAt == null && !state.markets.length) {
    f.push({ id: "equity", priority: 3, line: one("markets loading…", "dim") });
  } else if (a) {
    f.push({ id: "equity", priority: 3, line: one(`eq ${fmtUsd(a.equityUsd)}`) });
    f.push({ id: "upnl", priority: 2, line: [{ text: "uPnL " }, { text: fmtUsd(a.unrealizedPnlUsd, { sign: true }), tone: signTone(a.unrealizedPnlUsd) }] });
    const m = marginPct(a);
    const pct = m == null ? "—" : `${Math.round(m)}%`;
    f.push({ id: "margin", priority: 7, line: one(narrow ? `margin ${pct}` : `margin ${fmtUsd(a.marginUsedUsd, { decimals: 0 })} (${pct})`) });
    f.push({ id: "pos", priority: 6, line: one(`pos ${a.positions.length}`) });
    f.push({ id: "orders", priority: 9, line: one(`orders ${a.orders.length}`) });
  }

  const pollAge = state.marketsAt != null ? fmtAge(now - state.marketsAt) : "—";
  const ws =
    state.ws === "open"
      ? { line: one("ws live", "dim"), priority: 10 }
      : state.ws === "connecting"
        ? { line: one("ws connecting", "warn"), priority: 5 }
        : state.ws === "closed"
          ? { line: one(`ws down · poll ${pollAge}`, "critical"), priority: 5 }
          : { line: one("ws off", "dim"), priority: 5 };
  f.push({ id: "ws", ...ws });

  const n = state.alerts.length;
  const top = state.alerts.some((x) => x.level === "critical") ? "critical" : state.alerts.some((x) => x.level === "warn") ? "warn" : n ? "fg" : "dim";
  f.push({ id: "alerts", priority: n ? 4 : 11, line: one(`alerts ${n}`, top) });
  f.push({ id: "model", priority: 12, line: agentLabel ? one(agentLabel) : one("agent off", "dim") });
  return f;
}

/** Joined with two spaces, dropping the lowest-priority fields until it fits. */
export function statusLine(state: AppState, agentLabel: string | null, width: number, now: number): Line {
  let fields = statusFields(state, agentLabel, width, now);
  const join = (fs: Field[]): Line => fs.flatMap((x, i) => (i ? [{ text: "  " }, ...x.line] : x.line));
  while (fields.length > 1 && lineWidth(join(fields)) > width) {
    const worst = fields.reduce((a, b) => (b.priority > a.priority ? b : a));
    fields = fields.filter((x) => x !== worst);
  }
  return join(fields);
}

export function StatusBar({ state, agentLabel, width, now }: { state: AppState; agentLabel: string | null; width: number; now: number }) {
  return <SegLine line={statusLine(state, agentLabel, width, now)} />;
}
