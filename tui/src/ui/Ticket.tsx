// Ticket card (DESIGN.md §5): framed, network badge on the top border, rows only
// for non-null values, governor verdict, verbatim reasons/warnings/notes, and a
// footer that depends on phase and access. Plus the frozen note and ResultBlock.
import { Box, Text } from "ink";
import type { TicketUi } from "../app/model.js";
import type { SendResult, Ticket } from "../core/types.js";
import { fmtBps, fmtClock, fmtDist, fmtLev, fmtPx, fmtRr, fmtSz, fmtUsd, padEnd } from "./format.js";
import { lineWidth, padLine, SegLine, wrapSegs, type Line, type Seg } from "./segs.js";
import { g, tone, type Tone } from "./theme.js";

export function cardWidth(cols: number): number {
  return cols >= 82 ? 80 : Math.max(20, cols - 2);
}

const dist = (px: number | null, from: number | null) => (px == null || from == null || from === 0 ? null : ((px - from) / from) * 100);

/** Formatted field values, compared against the previous quote in the "changed" state. */
function fields(t: Ticket, ui: TicketUi) {
  const ref = t.entryPx ?? t.markPx ?? undefined;
  const px = (x: number | null) => (x == null ? null : fmtPx(x, ui.szDecimals, ref));
  const d = (x: number | null) => {
    const v = dist(x, t.entryPx);
    return v == null ? null : fmtDist(v);
  };
  return {
    size: t.size == null ? null : `${fmtSz(t.size, ui.szDecimals)} ${t.coin}`,
    notional: t.notionalUsd == null ? null : fmtUsd(t.notionalUsd),
    lev: t.leverage == null ? null : fmtLev(t.leverage),
    entry: px(t.entryPx),
    slip: t.slippageBps == null ? null : fmtBps(t.slippageBps),
    stop: px(t.stopPx),
    stopD: d(t.stopPx),
    tp: px(t.tpPx),
    tpD: d(t.tpPx),
    liq: px(t.liqPx),
    liqD: d(t.liqPx),
    rr: t.rr == null ? null : fmtRr(t.rr),
    risk: t.riskUsd == null ? null : fmtUsd(t.riskUsd),
    riskPct: t.riskPct == null ? null : `${t.riskPct.toFixed(2)}%`,
    verdict: verdictWord(t),
  };
}
type Fields = ReturnType<typeof fields>;

function verdictWord(t: Ticket): "PASS" | "CLIPPED" | "REJECTED" | null {
  if (!t.verdict) return null;
  if (!t.verdict.approved) return "REJECTED";
  return t.verdict.warnings.some((w) => /\bclipped\b/i.test(w)) || t.warnings.some((w) => /\bclipped\b/i.test(w)) ? "CLIPPED" : "PASS";
}

const VERDICT_TONE: Record<string, Tone> = { PASS: "pass", CLIPPED: "warn", REJECTED: "critical" };

export interface CardModel {
  title: string;
  badge: { text: string; tone: Tone };
  border: Tone;
  body: Line[];
  footerLeft: Line;
  footerRight: Line;
}

function footer(t: Ticket, ui: TicketUi, at: number): Line {
  const y = (label: string): Line => [{ text: "y", bold: true }, { text: label }, { text: " · n discard" }];
  switch (ui.phase) {
    case "frozen":
      if (ui.outcome === "failed") return [{ text: `send failed ${fmtClock(at)}`, tone: "critical" }];
      if (ui.outcome === "simulated") return [{ text: `simulated ${fmtClock(at)} (demo, nothing sent)`, tone: "dim" }];
      return [{ text: `sent ${fmtClock(at)}`, tone: "dim" }];
    case "requoting":
      return [{ text: "re-quoting…", tone: "dim" }];
    case "sending":
      return [{ text: `sending… ${t.action.kind === "open" && t.leverage != null ? `leverage ${fmtLev(t.leverage)} ${g().arrow} order` : "order"}`, tone: "dim" }];
    case "awaiting":
      if (ui.access === "demo") return y(" send (demo, simulated)");
      if (ui.access === "read-only") return [{ text: "read-only: no key · n/esc dismiss", tone: "dim" }];
      if (!t.canSend) return [{ text: "blocked", tone: "critical" }, { text: " · n/esc dismiss" }];
      if (ui.changedWhy) return y(" send new quote");
      return y(t.network === "mainnet" ? " send on MAINNET" : " send");
  }
}

/** The card as data: pure, so tests can read it without rendering. */
export function ticketCard(t: Ticket, ui: TicketUi, at: number): CardModel {
  const f = fields(t, ui);
  const prev = ui.previous && ui.phase !== "frozen" ? fields(ui.previous, ui) : null;
  const val = (k: keyof Fields, t0?: Tone): Seg[] => {
    const v = f[k];
    if (v == null) return [];
    const old = prev?.[k];
    if (prev && old !== v) return [{ text: v, tone: "warn" }, { text: ` (was ${old ?? "—"})`, tone: "dim" }];
    return [{ text: v, ...(t0 ? { tone: t0 } : {}) }];
  };
  const lab = (s: string, w = 10): Seg => ({ text: padEnd(s, w), tone: "dim" });
  const pair = (left: Line, right: Line): Line => (right.length ? [...padLine(left, 30), ...right] : left);

  const kind = t.action.kind.toUpperCase();
  const body: Line[] = [];
  if (ui.changedWhy && ui.phase !== "frozen") body.push([{ text: `! re-quoted: ${ui.changedWhy}`, tone: "warn" }]);

  // 1. headline
  const sideWord = t.side === "long" ? "LONG" : t.side === "short" ? "SHORT" : "";
  const sideSeg: Seg = { text: sideWord, tone: t.side === "long" ? "up" : "down", bold: true };
  const a = t.action;
  if (a.kind === "open") {
    const entry = a.intent.entry.type === "limit" ? `limit @${fmtPx(a.intent.entry.px, ui.szDecimals)}` : `market IOC ±${Number((ui.slippage * 100).toFixed(2))}%`;
    body.push([
      sideSeg,
      { text: ` ${t.coin}   ` },
      ...val("size"),
      ...(f.notional ? [{ text: "   ≈ " }, ...val("notional"), { text: " notional" }] : []),
      ...(f.lev ? [{ text: "   " }, ...val("lev"), { text: " cross" }] : []),
      { text: `   ${entry}` },
    ]);
  } else if (a.kind === "close") {
    body.push([
      { text: `CLOSE ${a.pct}% of `, bold: true },
      ...(sideWord ? [sideSeg] : []),
      { text: ` ${t.coin}  ` },
      ...val("size"),
      ...(f.notional ? [{ text: " ≈ " }, ...val("notional")] : []),
      { text: " · reduce-only IOC" },
    ]);
  } else if (a.kind === "cancel") {
    body.push([{ text: `CANCEL ${a.oids.length} order${a.oids.length === 1 ? "" : "s"}`, bold: true }]);
  } else {
    const d = dist(t.stopPx, t.markPx);
    body.push([
      { text: `MOVE STOP ${t.coin}  `, bold: true },
      { text: ui.oldStopPx != null ? fmtPx(ui.oldStopPx, ui.szDecimals, t.markPx ?? undefined) : "none" },
      { text: ` ${g().arrow} ` },
      ...val("stop"),
      ...(d != null ? [{ text: ` (${fmtDist(d)})`, tone: "dim" as const }] : []),
    ]);
  }
  if (t.network === "mainnet") body.push([{ text: "MAINNET · real funds · sending is irreversible", tone: "critical" }]);

  // 2–5. numbers (cancel has none; stop shows only liq/risk)
  if (a.kind === "open" || a.kind === "close") {
    if (f.entry || f.slip) body.push(pair(f.entry ? [lab("entry ≈"), ...val("entry")] : [], f.slip ? [lab("slippage est", 13), ...val("slip")] : []));
    if (f.stop || f.tp)
      body.push(
        pair(
          f.stop ? [lab("stop"), ...val("stop"), ...(f.stopD ? [{ text: "  " }, ...val("stopD", "dim")] : [])] : [],
          f.tp ? [lab("tp"), ...val("tp"), ...(f.tpD ? [{ text: "  " }, ...val("tpD", "dim")] : [])] : [],
        ),
      );
  }
  if (a.kind !== "cancel" && (f.liq || f.rr))
    body.push(pair(f.liq ? [lab("liq ≈"), ...val("liq"), ...(f.liqD && a.kind === "open" ? [{ text: " " }, ...val("liqD", "dim")] : [])] : [], f.rr ? [lab("R:R"), ...val("rr")] : []));
  if (f.risk) body.push([lab("risk"), ...val("risk"), ...(f.riskPct ? [{ text: " · " }, ...val("riskPct"), { text: " of equity" }] : [])]);

  // 6. governor
  body.push([]);
  if (f.verdict) {
    const was = prev && prev.verdict !== f.verdict ? [{ text: ` (was ${prev.verdict ?? "n/a"})`, tone: "dim" as const }] : [];
    body.push([lab("governor"), { text: f.verdict, tone: VERDICT_TONE[f.verdict] }, ...was]);
  } else body.push([lab("governor"), { text: "n/a · reduce-only", tone: "dim" }]);

  // 7. reasons / blockers, warnings, notes (verbatim, deduped)
  const crit = [...(t.verdict?.reasons ?? [])];
  for (const b of t.blockers) if (!crit.includes(b)) crit.push(b);
  const warns: string[] = [];
  const clipped = [...(t.verdict?.warnings ?? []), ...t.warnings].find((w) => /\bclipped\b/i.test(w));
  if (f.verdict === "CLIPPED" && clipped) warns.push(clipped);
  for (const w of [...(t.verdict?.warnings ?? []), ...t.warnings]) if (!warns.includes(w)) warns.push(w);
  for (const c of crit) body.push([{ text: `${g().cross} `, tone: "critical" }, { text: c, tone: "critical" }]);
  for (const w of warns) body.push([{ text: `! ${w}`, tone: "warn" }]);
  for (const n of t.notes) body.push([{ text: `· ${n}`, tone: "dim" }]);

  return {
    title: `TICKET ${t.id} · ${kind} · from ${ui.source}`,
    badge: t.network === "mainnet" ? { text: " MAINNET ", tone: "badgeMainnet" } : ui.access === "demo" ? { text: " DEMO ", tone: "badgeDemo" } : { text: " TESTNET ", tone: "badgeTestnet" },
    border: ui.phase === "frozen" ? "dim" : t.network === "mainnet" ? "critical" : "dim",
    body,
    footerLeft: footer(t, ui, at),
    footerRight: [{ text: `quoted ${fmtClock(t.quotedAt)}`, tone: "dim" }],
  };
}

/** Frame lines (with borders) for a card, clipped to maxHeight by eliding the middle. */
export function cardLines(m: CardModel, width: number, maxHeight = Infinity): Line[] {
  const W = cardWidth(width);
  const inner = W - 4;
  const box = g().box;
  const b = m.border;
  const fill = Math.max(1, W - 6 - lineWidth([{ text: m.title }]) - lineWidth([{ text: m.badge.text }]));
  const top: Line = [{ text: `${box.tl}${box.h} `, tone: b }, { text: m.title, bold: true }, { text: ` ${box.h.repeat(fill)}`, tone: b }, { text: m.badge.text, tone: m.badge.tone }, { text: `${box.h}${box.tr}`, tone: b }];
  const bottom: Line = [{ text: `${box.bl}${box.h.repeat(W - 2)}${box.br}`, tone: b }];
  let body = m.body.flatMap((l) => wrapSegs(l, inner, 2));
  const foot = wrapSegs([...m.footerLeft, { text: " ".repeat(Math.max(1, inner - lineWidth(m.footerLeft) - lineWidth(m.footerRight))) }, ...m.footerRight], inner, 0);
  const room = maxHeight - 2 - 1 - foot.length;
  if (body.length > room && room >= 2) {
    const hidden = body.length - (room - 1);
    body = [...body.slice(0, room - 1), [{ text: `${g().ellipsis} ${hidden} more line${hidden === 1 ? "" : "s"}`, tone: "dim" }]];
  }
  const side = (l: Line): Line => [{ text: `${box.v} `, tone: b }, ...padLine(l, inner), { text: ` ${box.v}`, tone: b }];
  return [top, ...body.map(side), side([]), ...foot.map(side), bottom];
}

export function TicketCard({ ticket, ui, width, at, maxHeight }: { ticket: Ticket; ui: TicketUi; width: number; at?: number; maxHeight?: number }) {
  const lines = cardLines(ticketCard(ticket, ui, at ?? ticket.quotedAt), width, maxHeight);
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <SegLine key={i} line={l} />
      ))}
    </Box>
  );
}

/** `– ticket t-3f2a discarded · LONG 0.0123 BTC ≈ $752.40` */
export function ticketSummary(t: Ticket, szDecimals: number): string {
  const side = t.side ? t.side.toUpperCase() : "";
  switch (t.action.kind) {
    case "open":
      return `${side} ${t.size != null ? fmtSz(t.size, szDecimals) : "—"} ${t.coin}${t.notionalUsd != null ? ` ≈ ${fmtUsd(t.notionalUsd)}` : ""}`;
    case "close":
      return `CLOSE ${t.action.pct}% ${side} ${t.coin}`;
    case "cancel":
      return `CANCEL ${t.action.oids.map((o) => o.oid).join(", ")}`;
    case "stop":
      return `MOVE STOP ${t.coin} ${fmtPx(t.stopPx, szDecimals)}`;
  }
}

export function TicketNote({ ticket, ui }: { ticket: Ticket; ui: TicketUi }) {
  return (
    <Text {...tone("dim")}>
      – ticket {ticket.id} {ui.outcome} · {ticketSummary(ticket, ui.szDecimals)}
    </Text>
  );
}

export function ResultBlock({ result, demo }: { result: SendResult; demo?: boolean }) {
  return (
    <Box flexDirection="column">
      {result.ok ? (
        <Text>
          <Text {...tone("pass")}>{g().check} </Text>
          <Text {...tone("pass")}>{demo ? "simulated" : "order sent"}</Text>
        </Text>
      ) : (
        <Text {...tone("critical")}>
          {g().cross} {demo ? "simulated: order refused" : "order failed"}
        </Text>
      )}
      {result.lines.map((l, i) => (
        <Text key={`l${i}`}>  · {l}</Text>
      ))}
      {result.errors.map((e, i) => (
        <Text key={`e${i}`} {...tone("critical")}>
          {"  "}
          {g().cross} {e}
        </Text>
      ))}
      {result.oids.length > 0 && <Text {...tone("dim")}>  oids {result.oids.join(" ")}</Text>}
    </Box>
  );
}

