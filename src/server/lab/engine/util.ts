// Small helpers shared by the engine modules.

/**
 * The engine declines a request as posed (too many features, too little
 * history, nothing to label): the caller's input to change, not a failure.
 * `field` names the argument to change.
 */
export class SearchRefused extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "SearchRefused";
    this.field = field;
  }
}

export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function parseDay(s: string): number {
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`invalid date "${s}" (want YYYY-MM-DD)`);
  return ms;
}

/** Finite values of col[from..to), sorted ascending. */
export function sortedFinite(col: ArrayLike<number>, from: number, to: number): Float64Array {
  const out = new Float64Array(Math.max(0, to - from));
  let m = 0;
  for (let i = Math.max(0, from); i < to; i++) {
    const x = col[i]!;
    if (Number.isFinite(x)) out[m++] = x;
  }
  return out.slice(0, m).sort();
}

/** Linear-interpolated quantile of a sorted array; NaN when empty. */
export function quantileSorted(s: ArrayLike<number>, q: number): number {
  const m = s.length;
  if (!m) return NaN;
  const pos = Math.min(1, Math.max(0, q)) * (m - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < m ? s[i]! + f * (s[i + 1]! - s[i]!) : s[i]!;
}

/** Share of values strictly below x (sorted input). */
export function ecdf(s: ArrayLike<number>, x: number): number {
  const m = s.length;
  if (!m) return NaN;
  let lo = 0;
  let hi = m;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (s[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo / m;
}

/** FNV-1a 32-bit over a string, from a given offset basis. */
export function fnv1a(s: string, basis = 0x811c9dc5): number {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 16 hex chars from two FNV-1a passes with different bases. */
export function hash64(s: string): string {
  return fnv1a(s).toString(16).padStart(8, "0") + fnv1a(s, 0x050c5d1f).toString(16).padStart(8, "0");
}
