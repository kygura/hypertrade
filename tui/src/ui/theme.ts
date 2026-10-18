// Semantic tokens (DESIGN.md §4.1). Only the 16 ANSI color names; primary text
// is the terminal default. NO_COLOR / FORCE_COLOR=0 / non-TTY stdout strip every
// color but keep bold, inverse and dim. HT_ASCII=1 swaps glyphs and borders.

export type Tone =
  | "fg"
  | "dim"
  | "up"
  | "down"
  | "warn"
  | "critical"
  | "accent"
  | "pass"
  | "badgeMainnet"
  | "badgeTestnet"
  | "badgeDemo"
  | "selected";

export interface ToneProps {
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
  inverse?: boolean;
}

const TOKENS: Record<Tone, ToneProps> = {
  fg: {},
  dim: { dimColor: true },
  up: { color: "green" },
  down: { color: "red" },
  warn: { color: "yellow" },
  critical: { color: "red", bold: true },
  accent: { color: "cyan" },
  pass: { color: "green", bold: true },
  badgeMainnet: { color: "red", inverse: true, bold: true },
  badgeTestnet: { color: "yellow", inverse: true },
  badgeDemo: { color: "magenta", inverse: true },
  selected: { inverse: true },
};

type Env = Record<string, string | undefined>;

export function colorEnabled(env: Env = process.env, isTTY: boolean = !!process.stdout.isTTY): boolean {
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR === "0") return false;
  return isTTY;
}

const UNICODE = {
  tool: "▸",
  prompt: "›",
  bullet: "●",
  check: "✓",
  cross: "✗",
  bar: "█",
  arrow: "→",
  ellipsis: "…",
  rule: "─",
  box: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
};
const ASCII: typeof UNICODE = {
  tool: ">",
  prompt: ">",
  bullet: "*",
  check: "+",
  cross: "x",
  bar: "#",
  arrow: "->",
  ellipsis: "...",
  rule: "-",
  box: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

export type Glyphs = typeof UNICODE;

let useColor = colorEnabled();
let glyphs: Glyphs = process.env.HT_ASCII === "1" ? ASCII : UNICODE;

/** Overrides detection (tests, main). */
export function configureTheme(o: { color?: boolean; ascii?: boolean }): void {
  if (o.color != null) useColor = o.color;
  if (o.ascii != null) glyphs = o.ascii ? ASCII : UNICODE;
}

export function g(): Glyphs {
  return glyphs;
}

/** Ink <Text> props for a token; colors dropped when color is off. */
export function tone(t: Tone | undefined): ToneProps {
  const p = TOKENS[t ?? "fg"];
  if (useColor || p.color == null) return p;
  const { color: _c, ...rest } = p;
  return rest;
}

/** up / down / fg by sign; exact zero is fg. */
export function signTone(x: number | null | undefined): Tone {
  if (x == null || !Number.isFinite(x) || x === 0) return "fg";
  return x > 0 ? "up" : "down";
}
