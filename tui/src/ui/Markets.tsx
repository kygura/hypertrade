// /markets: the table and the live overlay around it (DESIGN.md §2, §4.3, §6).
import { Box, Text } from "ink";
import { sortMarkets } from "../app/controller.js";
import type { MarketsOverlay as MarketsState } from "../app/model.js";
import type { AppState, MarketRow } from "../core/types.js";
import { aprOf, fmtAge, fmtApr, fmtFundingH, fmtPct, fmtPx, fmtUsdCompact, MISSING } from "./format.js";
import { SegLine, spread, type Line } from "./segs.js";
import { Table, type Column } from "./Table.js";
import { g, signTone, tone, type Tone } from "./theme.js";

const live = (m: MarketRow) => m.midPx ?? m.markPx;

export const MARKET_COLUMNS: Column<MarketRow>[] = [
  { key: "coin", header: "COIN", width: 9, align: "left", dropRank: 0, render: (m) => ({ text: m.coin }) },
  { key: "mark", header: "MARK", width: 11, align: "right", dropRank: 0, render: (m) => ({ text: fmtPx(live(m), m.szDecimals) }) },
  { key: "chg", header: "24H", width: 8, align: "right", dropRank: 0, render: (m) => ({ text: fmtPct(m.dayChangePct), tone: signTone(m.dayChangePct) }) },
  { key: "fund", header: "FUND/H", width: 9, align: "right", dropRank: 5, render: (m) => ({ text: fmtFundingH(m.fundingHourly), tone: signTone(m.fundingHourly) }) },
  { key: "apr", header: "APR", width: 8, align: "right", dropRank: 0, render: (m) => ({ text: fmtApr(m.fundingAprPct), tone: signTone(m.fundingAprPct) }) },
  {
    key: "pred",
    header: "PRED APR",
    width: 9,
    align: "right",
    dropRank: 3,
    render: (m) => (m.predictedFundingHourly == null ? { text: MISSING } : { text: fmtApr(aprOf(m.predictedFundingHourly)), tone: signTone(m.predictedFundingHourly) }),
  },
  { key: "oi", header: "OI", width: 9, align: "right", dropRank: 0, render: (m) => ({ text: fmtUsdCompact(m.oiUsd) }) },
  { key: "vol", header: "VOL", width: 9, align: "right", dropRank: 1, render: (m) => ({ text: fmtUsdCompact(m.dayVolumeUsd) }) },
  { key: "prem", header: "PREM", width: 8, align: "right", dropRank: 4, render: (m) => (m.premium == null ? { text: MISSING } : { text: fmtPct(m.premium * 100), tone: signTone(m.premium) }) },
  { key: "max", header: "MAX", width: 4, align: "right", dropRank: 2, render: (m) => ({ text: `${m.maxLeverage}x` }) },
  { key: "flag", header: "", width: 8, align: "left", dropRank: 6, render: (m) => ({ text: m.isDelisted ? "delisted" : m.atOiCap ? "cap" : "", tone: "dim" }) },
];

export function MarketsTable({ rows, width, selected, offset }: { rows: MarketRow[]; width: number; selected: number | null; offset: number }) {
  return <Table columns={MARKET_COLUMNS} rows={rows} width={width} selected={selected == null ? null : selected - offset} />;
}

/** Poll age tone: warn after 45 s, critical after 120 s. */
export function pollTone(ageMs: number): Tone {
  return ageMs > 120_000 ? "critical" : ageMs > 45_000 ? "warn" : "dim";
}

const WS_TEXT = { open: "ws live", connecting: "ws connecting", closed: "ws down", off: "ws off" } as const;

export interface MarketsOverlayProps {
  state: AppState;
  overlay: MarketsState;
  maxHeight: number;
  width: number;
  now: number;
}

/** Window start keeping `selected` in view, centred where possible. */
export function windowOffset(selected: number, total: number, visible: number): number {
  if (total <= visible) return 0;
  return Math.max(0, Math.min(total - visible, selected - Math.floor(visible / 2)));
}

export function MarketsOverlay({ state, overlay: o, maxHeight, width, now }: MarketsOverlayProps) {
  const rows = sortMarkets(state.markets, o.sort, o.dir, o.filter);
  const visible = Math.max(1, maxHeight - 3);
  const sel = rows.length ? Math.min(o.selected, rows.length - 1) : 0;
  const offset = windowOffset(sel, rows.length, visible);
  const age = state.marketsAt != null ? now - state.marketsAt : null;
  const left: Line = [
    { text: " MARKETS ", tone: "selected" },
    { text: `  sort ${o.sort} ${o.dir === "desc" ? "↓" : "↑"}  filter ${o.filter || MISSING}  ${state.markets.length} coins  `, tone: "dim" },
    age == null ? { text: "loading", tone: "dim" } : { text: `poll ${fmtAge(age)} ago`, tone: pollTone(age) },
    { text: `  ${WS_TEXT[state.ws]}`, tone: state.ws === "connecting" ? "warn" : state.ws === "closed" ? "critical" : "dim" },
  ];
  const right: Line = [{ text: rows.length ? `${sel + 1}/${rows.length}` : "0/0", tone: "dim" }];
  const footer: Line =
    o.editing != null
      ? [{ text: "filter: ", tone: "dim" }, { text: o.editing }, { text: g().bar, tone: "accent" }, { text: "  enter apply · esc cancel", tone: "dim" }]
      : [{ text: `↑↓ select · enter /coin · b /book · sort o oi  v vol  c chg  f funding${width >= 110 ? " (again reverses)" : ""} · / filter · esc close`, tone: "dim" }];

  let body;
  if (state.marketsAt == null && !state.markets.length) body = <Text {...tone("dim")}>loading markets…</Text>;
  else if (!rows.length) body = <Text {...tone("dim")}>no coin matches "{o.filter}"</Text>;
  else body = <MarketsTable rows={rows.slice(offset, offset + visible)} width={width} selected={sel} offset={offset} />;

  return (
    <Box flexDirection="column" height={maxHeight} width={width}>
      <SegLine line={spread(left, right, width)} />
      <Box flexDirection="column" flexGrow={1}>
        {body}
      </Box>
      <SegLine line={footer} />
    </Box>
  );
}
