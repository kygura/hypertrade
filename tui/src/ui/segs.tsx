// A line as toned segments: the unit most components build and the ticket frame pads.
import { Box, Text } from "ink";
import { strWidth } from "./format.js";
import { tone, type Tone } from "./theme.js";

export interface Seg {
  text: string;
  tone?: Tone;
  bold?: boolean;
}
export type Line = Seg[];

export const seg = (text: string, t?: Tone, bold?: boolean): Seg => ({ text, ...(t ? { tone: t } : {}), ...(bold ? { bold } : {}) });

export const lineText = (l: Line) => l.map((s) => s.text).join("");
export const lineWidth = (l: Line) => strWidth(lineText(l));

/** Pads a line with spaces to `w` cells. */
export function padLine(l: Line, w: number): Line {
  const n = w - lineWidth(l);
  return n > 0 ? [...l, { text: " ".repeat(n) }] : l;
}

/** Left part, spaces, right part, exactly `w` cells when it fits. */
export function spread(left: Line, right: Line, w: number): Line {
  const gap = w - lineWidth(left) - lineWidth(right);
  return [...left, { text: " ".repeat(Math.max(1, gap)) }, ...right];
}

/** Word-wraps toned segments to `width`; continuation lines start with `indent` spaces. */
export function wrapSegs(l: Line, width: number, indent = 0): Line[] {
  if (lineWidth(l) <= width) return [l];
  type Tok = { seg: Seg; space: boolean; w: number };
  const toks: Tok[] = [];
  for (const s of l) {
    for (const part of s.text.split(/( +)/)) {
      if (!part) continue;
      toks.push({ seg: { ...s, text: part }, space: part.startsWith(" "), w: strWidth(part) });
    }
  }
  const out: Line[] = [];
  let cur: Line = [];
  let w = 0;
  const limit = () => (out.length === 0 ? width : width - indent);
  for (const t of toks) {
    if (t.space) {
      if (w === 0) continue;
      cur.push(t.seg);
      w += t.w;
      continue;
    }
    if (w > 0 && w + t.w > limit()) {
      while (cur.length && cur[cur.length - 1]!.text.trim() === "") cur.pop();
      out.push(cur);
      cur = [];
      w = 0;
    }
    cur.push(t.seg);
    w += t.w;
  }
  if (cur.length) out.push(cur);
  return out.map((ln, i) => (i === 0 || !indent ? ln : [{ text: " ".repeat(indent) }, ...ln]));
}

export function SegLine({ line, pad }: { line: Line; pad?: number }) {
  const l = pad != null ? padLine(line, pad) : line;
  return (
    <Text wrap="truncate-end">
      {l.map((s, i) => (
        <Text key={i} {...tone(s.tone)} {...(s.bold ? { bold: true } : {})}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** Several lines, one <Text> each. */
export function SegLines({ lines }: { lines: Line[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <SegLine key={i} line={l} />
      ))}
    </Box>
  );
}
