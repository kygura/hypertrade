// /book: ladder, live overlay, and the one-line summary kept in scrollback.
import { Box, Text } from "ink";
import type { BookOverlay as BookState } from "../app/model.js";
import type { BookView, Level } from "../core/types.js";
import { fmtAge, fmtBps, fmtBpsNum, fmtClock, fmtPx, fmtSz, fmtUsdCompact, MISSING, padStart } from "./format.js";
import { SegLine, spread, type Line } from "./segs.js";
import { g, tone, type Tone } from "./theme.js";

interface LadderRow {
  px: number;
  sz: number;
  cum: number;
  side: "bid" | "ask";
}

function ladderRows(book: BookView, levels: number): { asks: LadderRow[]; bids: LadderRow[] } {
  const acc = (ls: Level[], side: "bid" | "ask") => {
    let cum = 0;
    return ls.slice(0, levels).map((l) => ({ px: l.px, sz: l.sz, cum: (cum += l.px * l.sz), side }));
  };
  // Asks print highest first so the touch sits next to the spread row.
  return { asks: acc(book.asks, "ask").reverse(), bids: acc(book.bids, "bid") };
}

function szDecimalsOf(levels: Level[]): number {
  let d = 0;
  for (const l of levels.slice(0, 10)) {
    const s = String(l.sz);
    if (s.includes(".")) d = Math.max(d, s.split(".")[1]!.length);
  }
  return Math.min(d, 5);
}

export function BookLadder({ book, levels, szDecimals, width }: { book: BookView; levels: number; szDecimals: number; width: number }) {
  const { asks, bids } = ladderRows(book, levels);
  const maxCum = Math.max(1, ...asks.map((r) => r.cum), ...bids.map((r) => r.cum));
  const showBar = width >= 100;
  const barW = Math.max(0, width - (11 + 10 + 9 + 3));
  const sd = szDecimalsOf([...book.bids, ...book.asks]);
  const ref = book.mid ?? book.bids[0]?.px ?? book.asks[0]?.px ?? 0;
  const line = (r: LadderRow): Line => {
    const t: Tone = r.side === "bid" ? "up" : "down";
    const out: Line = [
      { text: padStart(fmtPx(r.px, szDecimals, ref), 11), tone: t },
      { text: " " + padStart(fmtSz(r.sz, sd), 10) },
      { text: " " + padStart(fmtUsdCompact(r.cum), 9), tone: "dim" },
    ];
    if (showBar) out.push({ text: " " + g().bar.repeat(Math.max(1, Math.round((r.cum / maxCum) * barW))).slice(0, barW), tone: t });
    return out;
  };
  const header: Line = [{ text: `${padStart("PX", 11)} ${padStart("SIZE", 10)} ${padStart("CUM USD", 9)}`, tone: "dim" }];
  return (
    <Box flexDirection="column">
      <SegLine line={header} />
      {asks.map((r, i) => (
        <SegLine key={`a${i}`} line={line(r)} />
      ))}
      <Text {...tone("dim")}>
        {padStart(book.mid != null ? fmtPx(book.mid, szDecimals, ref) : MISSING, 11)} spread {fmtBps(book.spreadBps)}
      </Text>
      {bids.map((r, i) => (
        <SegLine key={`b${i}`} line={line(r)} />
      ))}
    </Box>
  );
}

/** `spread 0.8 bps · ±50bps $4.1M / $3.9M` and the $10k/$50k/$250k slippage table. */
export function BookStats({ book }: { book: BookView }) {
  const thin = book.slippage.filter((s) => s.buyBps == null || s.sellBps == null);
  return (
    <Box flexDirection="column">
      <Text {...tone("dim")}>
        spread {fmtBps(book.spreadBps)} · ±50bps {fmtUsdCompact(book.depth50Usd.bid)} / {fmtUsdCompact(book.depth50Usd.ask)}
      </Text>
      <Text {...tone("dim")}>{`${padStart("SIZE", 7)} ${padStart("BUY bps", 8)} ${padStart("SELL bps", 9)}`}</Text>
      {book.slippage.map((s) => (
        <Text key={s.sizeUsd}>{`${padStart(fmtUsdCompact(s.sizeUsd), 7)} ${padStart(fmtBpsNum(s.buyBps), 8)} ${padStart(fmtBpsNum(s.sellBps), 9)}`}</Text>
      ))}
      {thin.length > 0 && <Text {...tone("warn")}>book too thin for {fmtUsdCompact(thin[0]!.sizeUsd)}</Text>}
    </Box>
  );
}

export function BookOverlay({ overlay: o, szDecimals, maxHeight, width, now }: { overlay: BookState; szDecimals: number; maxHeight: number; width: number; now: number }) {
  const left: Line = [{ text: ` BOOK ${o.coin} `, tone: "selected" }, { text: `  levels ${o.levels}`, tone: "dim" }];
  const right: Line = o.book ? [{ text: `updated ${fmtAge(now - o.book.at)} ago`, tone: "dim" }] : [];
  let body;
  if (o.error) body = <Text {...tone("critical")}>book {o.coin}: {o.error} · esc closes</Text>;
  else if (!o.book) body = <Text {...tone("dim")}>fetching {o.coin} book…</Text>;
  else
    body = (
      <>
        <BookLadder book={o.book} levels={o.levels} szDecimals={szDecimals} width={width} />
        <BookStats book={o.book} />
      </>
    );
  return (
    <Box flexDirection="column" height={maxHeight} width={width} overflow="hidden">
      <SegLine line={spread(left, right, width)} />
      <Box flexDirection="column" flexGrow={1}>
        {body}
      </Box>
      <Text {...tone("dim")}>+/- levels · esc close{o.back ? " (back to markets)" : ""}</Text>
    </Box>
  );
}

/** One line kept in scrollback after the overlay closes. */
export function BookSummaryLine({ book, szDecimals, at }: { book: BookView; szDecimals: number; at: number }) {
  const s50 = book.slippage.find((s) => s.sizeUsd === 50_000);
  const slip = s50 ? ` · $50k slip ${fmtBpsNum(s50.buyBps)} / ${fmtBpsNum(s50.sellBps)} bps` : "";
  return (
    <Text {...tone("dim")}>
      BOOK {book.coin} · {fmtClock(at)} · mid {book.mid != null ? fmtPx(book.mid, szDecimals) : MISSING} · spread {fmtBps(book.spreadBps)} · ±50bps {fmtUsdCompact(book.depth50Usd.bid)} /{" "}
      {fmtUsdCompact(book.depth50Usd.ask)}
      {slip}
    </Text>
  );
}
