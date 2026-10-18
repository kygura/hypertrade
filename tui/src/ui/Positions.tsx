// Positions and orders: the /pos snapshot table, the one-line strip above the
// prompt (medium tier) and the side panel (wide tier). DESIGN.md §3, §4.3.
import { Box, Text } from "ink";
import type { AccountSnapshot, OpenOrder, PositionRow } from "../core/types.js";
import { fmtAge, fmtClock, fmtDist, fmtLev, fmtPx, fmtSz, fmtUsd, MISSING, padEnd, padStart } from "./format.js";
import { lineWidth, SegLine, type Line } from "./segs.js";
import { Table, type Column } from "./Table.js";
import { signTone, tone } from "./theme.js";

type SzMap = Record<string, number>;

/** Fallback when the coin's szDecimals is unknown: as many decimals as the size shows (max 5). */
function szDec(map: SzMap | undefined, coin: string, size: number): number {
  const d = map?.[coin];
  if (d != null) return d;
  const s = String(size);
  return Math.min(5, s.includes(".") ? s.split(".")[1]!.length : 0);
}

const nearStop = (p: PositionRow) => p.stopDistPct != null && Math.abs(p.stopDistPct) < 1;

export function positionColumns(szDecimals?: SzMap): Column<PositionRow>[] {
  const px = (p: PositionRow, v: number | null) => fmtPx(v, szDec(szDecimals, p.coin, p.size), p.markPx);
  return [
    { key: "coin", header: "COIN", width: 6, align: "left", dropRank: 0, render: (p) => ({ text: p.coin }) },
    { key: "side", header: "SIDE", width: 5, align: "left", dropRank: 0, render: (p) => ({ text: p.side === "long" ? "LONG" : "SHORT", tone: p.side === "long" ? "up" : "down" }) },
    { key: "size", header: "SIZE", width: 9, align: "right", dropRank: 5, render: (p) => ({ text: fmtSz(p.size, szDec(szDecimals, p.coin, p.size)) }) },
    { key: "entry", header: "ENTRY", width: 11, align: "right", dropRank: 4, render: (p) => ({ text: px(p, p.entryPx) }) },
    { key: "mark", header: "MARK", width: 11, align: "right", dropRank: 0, render: (p) => ({ text: px(p, p.markPx) }) },
    { key: "upnl", header: "uPnL", width: 10, align: "right", dropRank: 0, render: (p) => ({ text: fmtUsd(p.unrealizedPnlUsd, { sign: true }), tone: signTone(p.unrealizedPnlUsd) }) },
    { key: "lev", header: "LEV", width: 4, align: "right", dropRank: 6, render: (p) => ({ text: fmtLev(p.leverage) }) },
    { key: "stop", header: "STOP", width: 10, align: "right", dropRank: 3, render: (p) => (p.stopPx == null ? { text: MISSING, tone: "warn" } : { text: px(p, p.stopPx) }) },
    {
      key: "tostop",
      header: "→STOP",
      width: 6,
      align: "right",
      dropRank: 0,
      render: (p) => (p.stopDistPct == null ? { text: MISSING, tone: "warn" } : { text: fmtDist(p.stopDistPct), ...(nearStop(p) ? { tone: "warn" as const } : {}) }),
    },
    { key: "liq", header: "LIQ", width: 11, align: "right", dropRank: 2, render: (p) => ({ text: px(p, p.liqPx) }) },
    { key: "toliq", header: "→LIQ", width: 7, align: "right", dropRank: 0, render: (p) => ({ text: fmtDist(p.liqDistPct) }) },
    { key: "tp", header: "TP", width: 11, align: "right", dropRank: 7, render: (p) => ({ text: px(p, p.tpPx) }) },
  ];
}

export function PositionsTable({ positions, width, szDecimals, header = true }: { positions: PositionRow[]; width: number; szDecimals?: SzMap; header?: boolean }) {
  return <Table columns={positionColumns(szDecimals)} rows={positions} width={width} header={header} />;
}

function orderKind(o: OpenOrder): { kind: string; px: number } {
  if (o.isTrigger) return { kind: o.tpsl === "tp" ? "tp" : o.tpsl === "sl" ? "stop" : "trigger", px: o.triggerPx ?? o.limitPx };
  return { kind: "limit", px: o.limitPx };
}

function orderFlags(o: OpenOrder): string {
  return [o.tpsl, o.reduceOnly ? "ro" : null].filter(Boolean).join("·");
}

/** `81234 BTC sell 0.04500 stop 59,200.0 sl·ro` */
export function orderText(o: OpenOrder, szDecimals?: SzMap): string {
  const d = szDec(szDecimals, o.coin, o.size);
  const k = orderKind(o);
  const flags = orderFlags(o);
  return `${o.oid} ${o.coin} ${o.side} ${fmtSz(o.size, d)} ${k.kind} ${fmtPx(k.px, d)}${flags ? ` ${flags}` : ""}`;
}

export function OrdersList({ orders, width, szDecimals, now }: { orders: OpenOrder[]; width: number; szDecimals?: SzMap; now: number }) {
  if (orders.length < 4) {
    return (
      <Box width={width}>
        <Text>
          <Text {...tone("dim")}>ORDERS </Text> {orders.map((o) => orderText(o, szDecimals)).join("  ·  ")}
        </Text>
      </Box>
    );
  }
  const cols: Column<OpenOrder>[] = [
    { key: "oid", header: "OID", width: 9, align: "right", dropRank: 0, render: (o) => ({ text: String(o.oid) }) },
    { key: "coin", header: "COIN", width: 6, align: "left", dropRank: 0, render: (o) => ({ text: o.coin }) },
    { key: "side", header: "SIDE", width: 4, align: "left", dropRank: 0, render: (o) => ({ text: o.side, tone: o.side === "buy" ? "up" : "down" }) },
    { key: "size", header: "SIZE", width: 9, align: "right", dropRank: 0, render: (o) => ({ text: fmtSz(o.size, szDec(szDecimals, o.coin, o.size)) }) },
    { key: "px", header: "PX", width: 11, align: "right", dropRank: 0, render: (o) => ({ text: fmtPx(o.limitPx, szDec(szDecimals, o.coin, o.size)) }) },
    { key: "trig", header: "TRIGGER", width: 11, align: "right", dropRank: 2, render: (o) => ({ text: fmtPx(o.triggerPx, szDec(szDecimals, o.coin, o.size)) }) },
    { key: "type", header: "TYPE", width: 10, align: "left", dropRank: 1, render: (o) => ({ text: [orderKind(o).kind, orderFlags(o)].filter(Boolean).join(" ") }) },
    { key: "age", header: "AGE", width: 5, align: "right", dropRank: 3, render: (o) => ({ text: fmtAge(now - o.timestamp) }) },
  ];
  return <Table columns={cols} rows={orders} width={width} />;
}

export function marginPct(a: AccountSnapshot): number | null {
  return a.equityUsd > 0 ? (a.marginUsedUsd / a.equityUsd) * 100 : null;
}

/** /pos snapshot: header, positions table, orders. */
export function PosSnapshot({ account, configured, szDecimals, at, width, now }: { account: AccountSnapshot | null; configured: boolean; szDecimals: SzMap; at: number; width: number; now: number }) {
  if (!configured || !account) {
    return <Text {...tone("dim")}>no account configured — set HT_ACCOUNT or HT_AGENT_KEY</Text>;
  }
  const m = marginPct(account);
  const header: Line = [
    { text: `POSITIONS · ${fmtClock(at)} · eq ${fmtUsd(account.equityUsd)} · uPnL `, tone: "dim" },
    { text: fmtUsd(account.unrealizedPnlUsd, { sign: true }), tone: signTone(account.unrealizedPnlUsd) },
    { text: ` · margin ${fmtUsd(account.marginUsedUsd, { decimals: 0 })}${m != null ? ` (${Math.round(m)}%)` : ""}`, tone: "dim" },
  ];
  return (
    <Box flexDirection="column">
      <SegLine line={header} />
      {account.positions.length ? <PositionsTable positions={account.positions} width={width} szDecimals={szDecimals} /> : <Text {...tone("dim")}>no open positions</Text>}
      {account.orders.length ? <OrdersList orders={account.orders} width={width} szDecimals={szDecimals} now={now} /> : <Text {...tone("dim")}>no open orders</Text>}
    </Box>
  );
}

function stripItem(p: PositionRow): Line {
  return [
    { text: `${p.coin} ${p.side === "long" ? "L" : "S"} ` },
    { text: fmtUsd(p.unrealizedPnlUsd, { sign: true }), tone: signTone(p.unrealizedPnlUsd) },
    p.stopDistPct == null ? { text: " no stop", tone: "warn" } : { text: ` stop ${fmtDist(p.stopDistPct)}`, ...(nearStop(p) ? { tone: "warn" as const } : {}) },
  ];
}

/** `  BTC L +$34.11 stop -3.2%  ·  ETH S +$88.32 no stop`, `+N more` on overflow. */
export function stripLine(positions: PositionRow[], width: number): Line {
  const sep: Line = [{ text: "  ·  ", tone: "dim" }];
  let out: Line = [{ text: "  " }];
  for (let i = 0; i < positions.length; i++) {
    const item = [...(i ? sep : []), ...stripItem(positions[i]!)];
    const rest = positions.length - i - 1;
    const more: Line = rest ? [{ text: `  +${rest} more`, tone: "dim" }] : [];
    if (lineWidth(out) + lineWidth(item) + lineWidth(more) > width) {
      out.push({ text: `${i ? "  " : ""}+${positions.length - i} more`, tone: "dim" });
      break;
    }
    out = [...out, ...item];
  }
  return out;
}

export function PositionStrip({ positions, width }: { positions: PositionRow[]; width: number }) {
  if (!positions.length) return null;
  return <SegLine line={stripLine(positions, width)} />;
}

/** Wide-tier side panel, 42 cols. */
export function PositionsMini({ account, maxRows }: { account: AccountSnapshot | null; maxRows: number }) {
  if (!account) return <Text {...tone("dim")}>no account</Text>;
  const rows = account.positions.slice(0, Math.max(0, maxRows - 2));
  const m = marginPct(account);
  return (
    <Box flexDirection="column">
      <SegLine
        line={[
          { text: "POSITIONS  uPnL ", tone: "dim" },
          { text: fmtUsd(account.unrealizedPnlUsd, { sign: true }), tone: signTone(account.unrealizedPnlUsd) },
        ]}
      />
      {rows.map((p) => (
        <SegLine
          key={p.coin}
          line={[
            { text: padEnd(p.coin, 6) },
            { text: p.side === "long" ? "L " : "S ", tone: p.side === "long" ? "up" : "down" },
            { text: padStart(fmtSz(p.size, szDec(undefined, p.coin, p.size)), 10) },
            { text: padStart(fmtUsd(p.unrealizedPnlUsd, { sign: true }), 11), tone: signTone(p.unrealizedPnlUsd) },
            p.stopDistPct == null ? { text: padStart("no stop", 9), tone: "warn" } : { text: padStart(fmtDist(p.stopDistPct), 9), ...(nearStop(p) ? { tone: "warn" as const } : {}) },
          ]}
        />
      ))}
      {account.positions.length > rows.length && <Text {...tone("dim")}>+{account.positions.length - rows.length} more</Text>}
      <Text {...tone("dim")}>
        orders {account.orders.length} · margin {m != null ? `${Math.round(m)}%` : MISSING}
      </Text>
    </Box>
  );
}
