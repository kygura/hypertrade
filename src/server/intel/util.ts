import { mean } from "../desk/analytics.js";

// Small pure helpers shared by the intel modules (mean/stdev come from desk/analytics.ts).

export { mean, stdev } from "../desk/analytics.js";

/** Rounds to `dp` decimals. */
export const round = (x: number, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;

/** Case- and whitespace-insensitive key for node and entity names. */
export const norm = (s: string) => s.trim().toLowerCase();

export const iso = (d: Date | string) => new Date(d).toISOString();

/** Arithmetic mean, or null for an empty list. */
export const meanOrNull = (xs: number[]): number | null => (xs.length ? mean(xs) : null);

export { median } from "../../shared/signalMath.js";

/** The number if finite, else null. */
export const fin = (n: number | null | undefined): number | null => (n != null && Number.isFinite(n) ? n : null);
