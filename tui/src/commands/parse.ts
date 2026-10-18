// Pure parser for the prompt line. No I/O; the UI decides what to do with a Command.
import type { OrderStop } from "../../../src/shared/intel.js";
import type { Side } from "../core/types.js";

export const SORT_KEYS = ["oi", "vol", "chg", "funding"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type OrderSize = { usd: number } | { pctBook: number } | { riskPct: number };
export type OrderTp = { px: number } | { pct: number } | { r: number };

export interface OrderCommand {
  kind: "order";
  side: Side;
  coin: string;
  size: OrderSize | null;
  stop: OrderStop;
  tp: OrderTp | null;
  leverage: number | null;
  limitPx: number | null;
}

export type Command =
  | { kind: "noop" }
  | { kind: "agent"; text: string }
  | { kind: "markets"; sort?: SortKey; filter?: string }
  | { kind: "coin"; coin: string }
  | { kind: "book"; coin: string }
  | { kind: "pos" }
  | OrderCommand
  | { kind: "close"; coin: string; pct: number }
  | { kind: "cancel"; target: "all" | number; coin?: string }
  | { kind: "stop"; coin: string; px: number }
  | { kind: "alerts" }
  | { kind: "pulse" }
  | { kind: "brief" }
  | { kind: "model" }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "error"; message: string; token?: string };

export type ErrorCommand = Extract<Command, { kind: "error" }>;

export const ALIASES: Record<string, string> = { p: "pos", m: "markets", b: "book", q: "quit", h: "help", buy: "long", sell: "short" };
export const COMMAND_NAMES = [
  "markets", "coin", "book", "pos", "long", "short", "close", "cancel", "stop", "alerts", "pulse", "brief", "model", "clear", "help", "quit",
] as const;
const NO_ARGS = new Set(["pos", "alerts", "pulse", "brief", "model", "clear", "help", "quit"]);
const RESERVED = new Set(["risk", "stop", "tp", "book", "atr", "pdl", "pdh", "all"]);

const err = (message: string, token?: string): ErrorCommand => (token === undefined ? { kind: "error", message } : { kind: "error", message, token });

/** "1,000", "60k", "1.2m", optional leading "$". Null when not a plain positive-format number. */
function num(tok: string, suffix = true): number | null {
  const m = /^\$?(\d[\d,]*(?:\.\d+)?|\.\d+)([km])?$/i.exec(tok);
  if (!m || (m[2] && !suffix)) return null;
  const n = Number(m[1]!.replace(/,/g, "")) * (m[2] ? (m[2].toLowerCase() === "k" ? 1e3 : 1e6) : 1);
  return Number.isFinite(n) ? n : null;
}
const pctNum = (tok: string): number | null => (tok.endsWith("%") ? num(tok.slice(0, -1), false) : null);

/** Uppercase, except HL's lowercase "k" prefix (kPEPE) and a lowercase dex prefix (xyz:TSLA). Null if not a coin. */
export function normalizeCoin(tok: string): string | null {
  if (!/^([A-Za-z0-9]+:)?[A-Za-z][A-Za-z0-9]*$/.test(tok) || RESERVED.has(tok.toLowerCase())) return null;
  const [dex, sym] = tok.includes(":") ? (tok.split(":") as [string, string]) : [null, tok];
  const out = /^k[A-Za-z]/.test(sym) && /[A-Z]/.test(sym.slice(1)) ? "k" + sym.slice(1).toUpperCase() : sym.toUpperCase();
  return dex ? `${dex.toLowerCase()}:${out}` : out;
}

function parseOrder(side: Side, toks: string[]): Command {
  const verb = `/${side}`;
  const first = toks[0];
  if (first === undefined) return err(`usage: ${verb} COIN [$usd | N% book | risk N%] stop <px|N%|Natr|pdl|pdh> [tp ..] [Nx] [@px]`);
  const coin = normalizeCoin(first);
  if (!coin) return err(`expected a coin after ${verb}, got "${first}"`, first);

  let size: OrderSize | null = null, stop: OrderStop | null = null, tp: OrderTp | null = null, leverage: number | null = null, limitPx: number | null = null;
  const dup = (what: string, t: string) => err(`${what} given twice ("${t}")`, t);

  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]!;
    const low = t.toLowerCase();
    if (low === "risk") {
      const v = toks[++i];
      const p = v === undefined ? null : pctNum(v);
      if (p === null || p <= 0 || p > 100) return err(`risk needs a percent in (0,100], e.g. risk 0.5%${v ? ` (got "${v}")` : ""}`, v ?? t);
      if (size) return dup("size", t);
      size = { riskPct: p };
    } else if (low === "stop") {
      const v = toks[++i];
      if (v === undefined) return err("stop needs a value: <px>, <N>%, <N>atr, pdl or pdh", t);
      if (stop) return dup("stop", t);
      const vl = v.toLowerCase();
      const atr = /^(.+)atr$/i.exec(v);
      if (vl === "pdl") stop = { type: "prev_day_low" };
      else if (vl === "pdh") stop = { type: "prev_day_high" };
      else if (atr) {
        const m = num(atr[1]!, false);
        if (m === null || m <= 0 || m > 10) return err(`stop ATR multiple must be in (0,10], got "${v}"`, v);
        stop = { type: "atr_mult", mult: m };
      } else if (v.endsWith("%")) {
        const p = pctNum(v);
        if (p === null || p <= 0 || p > 50) return err(`stop percent must be in (0,50], got "${v}"`, v);
        stop = { type: "pct", pct: p };
      } else {
        const px = num(v);
        if (px === null || px <= 0) return err(`bad stop value "${v}": use <px>, <N>%, <N>atr, pdl or pdh`, v);
        stop = { type: "price", px };
      }
    } else if (low === "tp") {
      const v = toks[++i];
      if (v === undefined) return err("tp needs a value: <px>, <N>% or <N>R", t);
      if (tp) return dup("tp", t);
      const r = /^(.+)r$/i.exec(v);
      const val = r ? num(r[1]!, false) : v.endsWith("%") ? pctNum(v) : num(v);
      if (val === null || val <= 0) return err(`bad tp value "${v}": use <px>, <N>% or <N>R`, v);
      tp = r ? { r: val } : v.endsWith("%") ? { pct: val } : { px: val };
    } else if (t.startsWith("$")) {
      const usd = num(t);
      if (usd === null || usd <= 0) return err(`bad size "${t}": use $<usd>, e.g. $500 or $2k`, t);
      if (size) return dup("size", t);
      size = { usd };
    } else if (pctNum(t.replace(/book$/i, "")) !== null && (/book$/i.test(t) || toks[i + 1]?.toLowerCase() === "book")) {
      const p = pctNum(t.replace(/book$/i, ""))!;
      if (p <= 0 || p > 100) return err(`% book must be in (0,100], got "${t}"`, t);
      if (!/book$/i.test(t)) i++;
      if (size) return dup("size", t);
      size = { pctBook: p };
    } else if (/^\d+(\.\d+)?x$/i.test(t)) {
      const lev = Number(t.slice(0, -1));
      if (lev < 1 || lev > 50) return err(`leverage must be 1x-50x, got "${t}"`, t);
      if (leverage !== null) return dup("leverage", t);
      leverage = lev;
    } else if (t.startsWith("@")) {
      const px = num(t.slice(1));
      if (px === null || px <= 0) return err(`bad limit price "${t}": use @<px>`, t);
      if (limitPx !== null) return dup("limit", t);
      limitPx = px;
    } else if (pctNum(t) !== null) {
      return err(`"${t}" is ambiguous: write "${t} book", "risk ${t}" or "stop ${t}"`, t);
    } else {
      return err(`unknown token "${t}"`, t);
    }
  }
  if (!stop) return err("stop is required: add e.g. `stop 2%`, `stop 60000`, `stop 1.5atr` or `stop pdl`", "stop");
  return { kind: "order", side, coin, size, stop, tp, leverage, limitPx };
}

function parseSlash(line: string): Command {
  const [head, ...args] = line.split(/\s+/) as [string, ...string[]];
  const raw = head.slice(1).toLowerCase();
  const name = ALIASES[raw] ?? raw;
  const extra = (n: number): ErrorCommand | null => (args.length > n ? err(`unexpected "${args[n]}" after /${raw}`, args[n]) : null);
  const coinArg = (): string | ErrorCommand => {
    if (args[0] === undefined) return err(`usage: /${raw} COIN`);
    return normalizeCoin(args[0]) ?? err(`"${args[0]}" is not a coin`, args[0]);
  };

  if (NO_ARGS.has(name)) return extra(0) ?? ({ kind: name } as Command);
  switch (name) {
    case "markets": {
      let sort: SortKey | undefined, filter: string | undefined;
      for (const a of args) {
        const k = a.toLowerCase();
        if ((SORT_KEYS as readonly string[]).includes(k)) {
          if (sort) return err(`sort given twice ("${a}")`, a);
          sort = k as SortKey;
        } else {
          if (filter) return err(`unexpected "${a}": one filter only (sort keys: ${SORT_KEYS.join(" ")})`, a);
          filter = a;
        }
      }
      return { kind: "markets", ...(sort && { sort }), ...(filter && { filter }) };
    }
    case "coin":
    case "book": {
      const c = coinArg();
      return typeof c !== "string" ? c : (extra(1) ?? { kind: name, coin: c });
    }
    case "long":
    case "short":
      return parseOrder(name, args);
    case "close": {
      const c = coinArg();
      if (typeof c !== "string") return c;
      let pct = 100;
      if (args[1] !== undefined) {
        const p = args[1].endsWith("%") ? pctNum(args[1]) : num(args[1], false);
        if (p === null || p <= 0 || p > 100) return err(`close percent must be in (0,100], got "${args[1]}"`, args[1]);
        pct = p;
      }
      return extra(2) ?? { kind: "close", coin: c, pct };
    }
    case "cancel": {
      const t = args[0];
      if (t === undefined) return err("usage: /cancel <oid>|all [coin]");
      let target: "all" | number;
      if (t.toLowerCase() === "all") target = "all";
      else if (/^\d+$/.test(t) && Number.isSafeInteger(Number(t)) && Number(t) > 0) target = Number(t);
      else return err(`"${t}" is not an order id (use a number or "all")`, t);
      let coin: string | undefined;
      if (args[1] !== undefined) {
        coin = normalizeCoin(args[1]) ?? undefined;
        if (!coin) return err(`"${args[1]}" is not a coin`, args[1]);
      }
      return extra(2) ?? { kind: "cancel", target, ...(coin && { coin }) };
    }
    case "stop": {
      const c = coinArg();
      if (typeof c !== "string") return c;
      if (args[1] === undefined) return err("usage: /stop COIN <px>");
      const px = num(args[1]);
      if (px === null || px <= 0) return err(`bad stop price "${args[1]}"`, args[1]);
      return extra(2) ?? { kind: "stop", coin: c, px };
    }
    default:
      return err(`unknown command "${head}" (try /help)`, head);
  }
}

export function parseInput(text: string): Command {
  const line = text.trim();
  if (!line) return { kind: "noop" };
  return line.startsWith("/") ? parseSlash(line) : { kind: "agent", text: line };
}
