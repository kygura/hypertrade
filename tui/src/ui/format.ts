// Number and text formatting for the TUI (DESIGN.md §4.2). Pure; locale-independent
// (always en-US separators, ASCII +/- signs). src/shared/format.ts is not reused:
// its helpers are locale-dependent and use different precision rules.

export const MISSING = "—";

const ok = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Fixed decimals with thousands separators, no sign handling beyond a leading "-". */
export function fixed(x: number, decimals: number): string {
  const s = Math.abs(x).toFixed(Math.max(0, decimals));
  const [i, f] = s.split(".") as [string, string?];
  const body = f != null ? `${group(i)}.${f}` : group(i);
  return x < 0 && Number(s) !== 0 ? `-${body}` : body;
}

/**
 * Decimals for a coin's prices in one view: 5 significant figures at `refPx`,
 * capped at 6 − szDecimals (Hyperliquid's tick rule), and at least one decimal
 * when the cap allows (DESIGN mockups print BTC as 61,170.0).
 */
export function pxDecimals(refPx: number, szDecimals: number): number {
  const cap = Math.max(0, 6 - szDecimals);
  if (!ok(refPx) || refPx === 0) return Math.min(cap, 2);
  const intDigits = Math.floor(Math.log10(Math.abs(refPx))) + 1;
  const sig = Math.max(0, 5 - intDigits);
  return Math.min(cap, Math.max(sig, Math.min(1, cap)));
}

/** Price: decimals from `refPx` (default: px itself) so a column of one coin aligns. */
export function fmtPx(px: number | null | undefined, szDecimals: number, refPx?: number): string {
  if (!ok(px)) return MISSING;
  return fixed(px, pxDecimals(refPx ?? px, szDecimals));
}

/** Size: exactly szDecimals decimals. */
export function fmtSz(sz: number | null | undefined, szDecimals: number): string {
  return ok(sz) ? fixed(sz, szDecimals) : MISSING;
}

/** USD, market scale: 3 significant figures with K/M/B/T. */
export function fmtUsdCompact(x: number | null | undefined): string {
  if (!ok(x)) return MISSING;
  const a = Math.abs(x);
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  let body = "";
  for (const [k, u] of units) {
    if (a >= k * 0.9995) {
      const v = (a / k).toPrecision(3);
      // 999.6K rounds to 1000K: promote to the next unit.
      if (Number(v) >= 1000 && u !== "T") continue;
      body = `$${Number(v) >= 1000 ? Math.round(a / k) : v}${u}`;
      break;
    }
  }
  if (!body) body = `$${Number(a.toPrecision(3))}`;
  return x < 0 ? `-${body}` : body;
}

/** USD, account scale: $12,345.67 below $1M, compact above. `sign` adds + for positives. */
export function fmtUsd(x: number | null | undefined, opts: { sign?: boolean; decimals?: number } = {}): string {
  if (!ok(x)) return MISSING;
  const a = Math.abs(x);
  const body = a >= 1e6 ? fmtUsdCompact(a) : `$${fixed(a, opts.decimals ?? 2)}`;
  if (x < 0 && body !== "$0.00" && body !== "$0") return `-${body}`;
  return opts.sign && x > 0 ? `+${body}` : body;
}

/** Signed percent (input already in percent): 2 decimals, 0 when |x| ≥ 100. */
export function fmtPct(x: number | null | undefined): string {
  if (!ok(x)) return MISSING;
  const d = Math.abs(x) >= 100 ? 0 : 2;
  const s = Math.abs(x).toFixed(d);
  if (Number(s) === 0) return `${s}%`;
  return `${x < 0 ? "-" : "+"}${s}%`;
}

/** Distance percent (→STOP, →LIQ, ticket distances): signed, 1 decimal. */
export function fmtDist(x: number | null | undefined): string {
  if (!ok(x)) return MISSING;
  const s = Math.abs(x).toFixed(1);
  if (Number(s) === 0) return `${s}%`;
  return `${x < 0 ? "-" : "+"}${s}%`;
}

/** Hourly funding (fraction): 4-decimal percent, signed only when negative. */
export function fmtFundingH(hourly: number | null | undefined): string {
  if (!ok(hourly)) return MISSING;
  const s = Math.abs(hourly * 100).toFixed(4);
  return hourly < 0 && Number(s) !== 0 ? `-${s}%` : `${s}%`;
}

/** APR percent (input in percent): signed, 1 decimal. */
export function fmtApr(pct: number | null | undefined): string {
  if (!ok(pct)) return MISSING;
  const s = Math.abs(pct).toFixed(1);
  if (Number(s) === 0) return `${s}%`;
  return `${pct < 0 ? "-" : "+"}${s}%`;
}

/** Hourly funding fraction → APR percent. */
export const aprOf = (hourly: number) => hourly * 24 * 365 * 100;

/** bps number only: 1 decimal below 10, integer from 10 (for columns headed "bps"). */
export function fmtBpsNum(bps: number | null | undefined): string {
  if (!ok(bps)) return MISSING;
  return Math.abs(bps) < 10 ? bps.toFixed(1) : String(Math.round(bps));
}

export function fmtBps(bps: number | null | undefined): string {
  return ok(bps) ? `${fmtBpsNum(bps)} bps` : MISSING;
}

export function fmtLev(x: number | null | undefined): string {
  if (!ok(x)) return MISSING;
  return `${Number(x.toFixed(1))}x`;
}

export function fmtRr(x: number | null | undefined): string {
  return ok(x) ? String(Number(x.toFixed(2))) : MISSING;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Local clock HH:MM:SS. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Age: 6s, 4m, 2h, 3d. */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** 0x3fA2…91c0 (6 + 4). */
export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Display width in terminal cells. */
export function strWidth(s: string): number {
  return Bun.stringWidth(s);
}

export function padEnd(s: string, w: number): string {
  const n = w - strWidth(s);
  return n > 0 ? s + " ".repeat(n) : s;
}

export function padStart(s: string, w: number): string {
  const n = w - strWidth(s);
  return n > 0 ? " ".repeat(n) + s : s;
}

/** Cuts to `w` cells (no ellipsis; callers size columns so this is a safety net). */
export function clipTo(s: string, w: number): string {
  if (strWidth(s) <= w) return s;
  let out = "";
  for (const ch of s) {
    if (strWidth(out + ch) > w) break;
    out += ch;
  }
  return out;
}

/** Greedy word wrap at `width` cells; continuation lines start with `indent` spaces. */
export function wrapText(s: string, width: number, indent = 0): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    let lineW = 0;
    const max = () => (out.length === 0 ? width : width - indent);
    for (const word of para.split(/ +/)) {
      if (!word) continue;
      const w = strWidth(word);
      if (lineW === 0) {
        line = word;
        lineW = w;
      } else if (lineW + 1 + w <= max()) {
        line += " " + word;
        lineW += 1 + w;
      } else {
        out.push(line);
        line = word;
        lineW = w;
      }
    }
    out.push(line);
  }
  return out.map((l, i) => (i === 0 ? l : " ".repeat(indent) + l));
}
