// The only table primitive (DESIGN.md §3 Views, §4.3): fixed-width columns, one
// space gap, highest dropRank dropped first until the table fits.
import { Box } from "ink";
import { clipTo, padEnd, padStart } from "./format.js";
import { SegLine, type Line } from "./segs.js";
import type { Tone } from "./theme.js";

export interface Cell {
  text: string;
  tone?: Tone;
}

export interface Column<R> {
  key: string;
  header: string;
  width: number;
  align: "left" | "right";
  /** 0 = never dropped; highest drops first. */
  dropRank: number;
  render(row: R): Cell;
}

/** Columns that fit `width`, in their original order. */
export function fitColumns<R>(columns: Column<R>[], width: number): Column<R>[] {
  let cols = [...columns];
  const total = (cs: Column<R>[]) => cs.reduce((a, c) => a + c.width, 0) + Math.max(0, cs.length - 1);
  while (total(cols) > width) {
    const droppable = cols.filter((c) => c.dropRank > 0);
    if (!droppable.length) break;
    const worst = droppable.reduce((a, b) => (b.dropRank > a.dropRank ? b : a));
    cols = cols.filter((c) => c !== worst);
  }
  return cols;
}

const fit = (text: string, w: number, align: "left" | "right") => {
  const t = clipTo(text, w);
  return align === "right" ? padStart(t, w) : padEnd(t, w);
};

export function headerLine<R>(cols: Column<R>[]): Line {
  return [{ text: cols.map((c) => fit(c.header, c.width, c.align)).join(" "), tone: "dim" }];
}

export function rowLine<R>(cols: Column<R>[], row: R, selected = false): Line {
  const out: Line = [];
  cols.forEach((c, i) => {
    const cell = c.render(row);
    if (i > 0) out.push({ text: " ", ...(selected ? { tone: "selected" as const } : {}) });
    out.push({ text: fit(cell.text, c.width, c.align), ...(selected ? { tone: "selected" as const } : cell.tone ? { tone: cell.tone } : {}) });
  });
  return out;
}

export interface TableProps<R> {
  columns: Column<R>[];
  rows: R[];
  width: number;
  /** Index into rows rendered inverse. */
  selected?: number | null;
  header?: boolean;
}

export function Table<R>({ columns, rows, width, selected = null, header = true }: TableProps<R>) {
  const cols = fitColumns(columns, width);
  return (
    <Box flexDirection="column">
      {header && <SegLine line={headerLine(cols)} />}
      {rows.map((r, i) => (
        <SegLine key={i} line={rowLine(cols, r, i === selected)} />
      ))}
    </Box>
  );
}
