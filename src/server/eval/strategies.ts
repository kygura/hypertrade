// Strategy families for the eval lab (docs/EVAL.md §3). A spec is a family plus numeric params; `positions` turns it
// into a target position per day in [-maxLev, maxLev], decided at that day's close from data up to it (the Lab's
// convention: pos[i] earns r[i+1]). Every family shares two overlays:
//   regimes   the regimes the strategy may hold a position in (empty = all); outside them it is flat
//   volTarget annualized vol target in percent (0 = off): the position is scaled by volTarget / iv, so exposure falls
//             as implied vol rises (capped at maxLev). This is how "least implied volatility" enters the strategy.
import type { EvalPanel } from "./panel.js";
import { trailingMean } from "./panel.js";
import { REGIMES, rollingMax, type Regime } from "./regimes.js";

export const FAMILIES = ["trend", "breakout", "meanrev", "capitulation", "funding", "hold"] as const;
export type Family = (typeof FAMILIES)[number];

export interface StrategySpec {
  family: Family;
  params: Record<string, number>;
  /** Regimes the strategy may hold in; empty or absent = all. */
  regimes?: Regime[];
  /** Short side allowed (perps). */
  short?: boolean;
}

export interface ParamRange {
  lo: number;
  hi: number;
  int?: boolean;
}

/** Search space per family, and the shared overlays. */
export const PARAM_SPACE: Record<Family, Record<string, ParamRange>> = {
  trend: { fast: { lo: 5, hi: 60, int: true }, slow: { lo: 30, hi: 250, int: true } },
  breakout: { entry: { lo: 10, hi: 120, int: true }, exit: { lo: 5, hi: 60, int: true } },
  meanrev: { win: { lo: 10, hi: 120, int: true }, entryZ: { lo: 0.8, hi: 3 }, exitZ: { lo: -0.5, hi: 1 } },
  capitulation: { gap: { lo: 0, hi: 0.35 }, fng: { lo: 5, hi: 40, int: true }, exitGap: { lo: -0.05, hi: 0.4 }, maxHold: { lo: 20, hi: 240, int: true } },
  funding: { win: { lo: 7, hi: 60, int: true }, z: { lo: 0.5, hi: 3 } },
  hold: {},
};
export const OVERLAY_SPACE: Record<string, ParamRange> = { volTarget: { lo: 0, hi: 80 }, maxLev: { lo: 0.5, hi: 2 } };

export const DEFAULT_SPECS: Record<Family, StrategySpec> = {
  trend: { family: "trend", params: { fast: 20, slow: 100, volTarget: 0, maxLev: 1 } },
  breakout: { family: "breakout", params: { entry: 55, exit: 20, volTarget: 0, maxLev: 1 } },
  meanrev: { family: "meanrev", params: { win: 30, entryZ: 1.5, exitZ: 0, volTarget: 0, maxLev: 1 } },
  capitulation: { family: "capitulation", params: { gap: 0.1, fng: 20, exitGap: 0.15, maxHold: 120, volTarget: 0, maxLev: 1 } },
  funding: { family: "funding", params: { win: 30, z: 1.5, volTarget: 0, maxLev: 1 } },
  hold: { family: "hold", params: { volTarget: 0, maxLev: 1 } },
};

const p = (s: StrategySpec, k: string, d: number) => (Number.isFinite(s.params[k]) ? s.params[k]! : d);

function rollingMin(x: readonly number[], win: number): number[] {
  return rollingMax(
    x.map((v) => -v),
    win,
  ).map((v) => -v);
}

function rollingSd(x: readonly number[], win: number): number[] {
  const out = new Array<number>(x.length).fill(NaN);
  for (let i = win - 1; i < x.length; i++) {
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let j = i - win + 1; j <= i; j++) {
      const v = x[j]!;
      if (!Number.isFinite(v)) continue;
      s += v;
      s2 += v * v;
      n++;
    }
    if (n >= win * 0.8) out[i] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  return out;
}

/** Raw signal per family in [-1, 1] (before overlays). Stateful families carry their position day to day. */
function rawSignal(spec: StrategySpec, d: EvalPanel): number[] {
  const n = d.price.length;
  const px = d.price;
  const sig = new Array<number>(n).fill(0);
  const allowShort = Boolean(spec.short);
  switch (spec.family) {
    case "hold":
      return sig.map((_, i) => (Number.isFinite(px[i]!) ? 1 : 0));
    case "trend": {
      const fast = trailingMean(px, Math.round(p(spec, "fast", 20)));
      const slow = trailingMean(px, Math.round(Math.max(p(spec, "slow", 100), p(spec, "fast", 20) + 5)));
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(fast[i]!) || !Number.isFinite(slow[i]!)) continue;
        sig[i] = fast[i]! > slow[i]! ? 1 : allowShort ? -1 : 0;
      }
      return sig;
    }
    case "breakout": {
      const ent = Math.round(p(spec, "entry", 55));
      const ex = Math.round(Math.min(p(spec, "exit", 20), ent));
      const hiE = rollingMax(px, ent);
      const loE = rollingMin(px, ent);
      const hiX = rollingMax(px, ex);
      const loX = rollingMin(px, ex);
      let pos = 0;
      for (let i = 1; i < n; i++) {
        const x = px[i]!;
        // Channels from the days before i, so today's close can break them.
        if (pos === 0) {
          if (x > hiE[i - 1]!) pos = 1;
          else if (allowShort && x < loE[i - 1]!) pos = -1;
        } else if (pos === 1 && x < loX[i - 1]!) pos = 0;
        else if (pos === -1 && x > hiX[i - 1]!) pos = 0;
        sig[i] = pos;
      }
      return sig;
    }
    case "meanrev": {
      const win = Math.round(p(spec, "win", 30));
      const lp = px.map((x) => Math.log(x));
      const m = trailingMean(lp, win);
      const sd = rollingSd(lp, win);
      const ez = p(spec, "entryZ", 1.5);
      const xz = p(spec, "exitZ", 0);
      let pos = 0;
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(m[i]!) || !(sd[i]! > 0)) continue;
        const z = (lp[i]! - m[i]!) / sd[i]!;
        if (pos === 0) {
          if (z < -ez) pos = 1;
          else if (allowShort && z > ez) pos = -1;
        } else if (pos === 1 && z > xz) pos = 0;
        else if (pos === -1 && z < -xz) pos = 0;
        sig[i] = pos;
      }
      return sig;
    }
    case "capitulation": {
      // Long the washout: price under the STH cost basis by `gap` with fear at or under `fng`; out once price is back
      // over the cost basis by `exitGap` or after `maxHold` days. Long only.
      const gap = p(spec, "gap", 0.1);
      const fngMax = p(spec, "fng", 20);
      const exitGap = p(spec, "exitGap", 0.15);
      const maxHold = Math.round(p(spec, "maxHold", 120));
      let held = -1;
      for (let i = 0; i < n; i++) {
        const sth = d.sthRp[i]!;
        if (!(sth > 0)) continue;
        const g = px[i]! / sth - 1;
        const f = d.fng[i]!;
        if (held < 0) {
          if (g < -gap && (!Number.isFinite(f) || f <= fngMax)) held = 0;
        } else {
          held++;
          if (g > exitGap || held >= maxHold) held = -1;
        }
        sig[i] = held >= 0 ? 1 : 0;
      }
      return sig;
    }
    case "funding": {
      // Fade crowded funding: long when funding is unusually negative (shorts pay), short (if allowed) when unusually
      // positive. z of daily funding over `win` days.
      const win = Math.round(p(spec, "win", 30));
      const m = trailingMean(d.funding, win);
      const sd = rollingSd(d.funding, win);
      const zt = p(spec, "z", 1.5);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(m[i]!) || !(sd[i]! > 0) || !Number.isFinite(d.funding[i]!)) continue;
        const z = (d.funding[i]! - m[i]!) / sd[i]!;
        sig[i] = z < -zt ? 1 : z > zt && allowShort ? -1 : 0;
      }
      return sig;
    }
  }
}

/** Target positions: raw signal × regime gate × vol-target overlay, clipped to ±maxLev. */
export function positions(spec: StrategySpec, d: EvalPanel, regimes?: readonly Regime[]): number[] {
  const raw = rawSignal(spec, d);
  const allow = spec.regimes?.length ? new Set(spec.regimes) : null;
  const vt = p(spec, "volTarget", 0);
  const maxLev = p(spec, "maxLev", 1);
  return raw.map((s, i) => {
    if (s === 0) return 0;
    if (allow && regimes && !allow.has(regimes[i]!)) return 0;
    let size = 1;
    if (vt > 0) {
      const iv = d.iv[i]!;
      size = Number.isFinite(iv) && iv > 0 ? vt / iv : 1;
    }
    return Math.max(-maxLev, Math.min(maxLev, s * size));
  });
}

/** A spec with every param inside its range (ints rounded), unknown params dropped, regimes de-duplicated. */
export function normalizeSpec(spec: StrategySpec): StrategySpec {
  const space = { ...PARAM_SPACE[spec.family], ...OVERLAY_SPACE };
  const params: Record<string, number> = {};
  for (const [k, r] of Object.entries(space)) {
    const v = Number.isFinite(spec.params[k]) ? spec.params[k]! : (DEFAULT_SPECS[spec.family].params[k] ?? r.lo);
    const c = Math.max(r.lo, Math.min(r.hi, v));
    params[k] = r.int ? Math.round(c) : Math.round(c * 1e4) / 1e4;
  }
  const regimes = spec.regimes?.filter((r) => (REGIMES as readonly string[]).includes(r));
  return { family: spec.family, params, ...(regimes?.length ? { regimes: [...new Set(regimes)] } : {}), ...(spec.short ? { short: true } : {}) };
}

/** Stable text key for a spec (dedupe in the results log). */
export function specKey(spec: StrategySpec): string {
  const s = normalizeSpec(spec);
  const ps = Object.keys(s.params)
    .sort()
    .map((k) => `${k}=${s.params[k]}`)
    .join(",");
  return `${s.family}${s.short ? "±" : "+"}[${ps}]${s.regimes ? `@${[...s.regimes].sort().join("|")}` : ""}`;
}
