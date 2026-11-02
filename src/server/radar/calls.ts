import { RADAR_HORIZONS, type RadarCall, type RadarCallInput, type RadarCallsFile, type RadarState } from "../../shared/radar.js";
import type { RadarMarket } from "./scan.js";

// The radar's call ledger (ROUTINE.md §3): the session proposes, code stamps prices, rejects what it cannot
// check, and grades every call against BTC at fixed horizons. Pure: scripts/radar.ts does the I/O.

/** A call on the same market and stance within this many days is a repeat, not news. */
export const REPEAT_DAYS = 3;
/** A horizon grade accepts a snapshot up to this many days late (missed runs). */
const GRADE_SLACK_DAYS = 2;

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export interface Landed {
  file: RadarCallsFile;
  landed: RadarCall[];
  rejected: { market: string; reason: string }[];
}

export function landCalls(inputs: RadarCallInput[], markets: RadarMarket[], file: RadarCallsFile, today: string, at: string): Landed {
  const byKey = new Map(markets.map((m) => [m.key, m]));
  const btc = byKey.get("BTC")?.mark;
  const landed: RadarCall[] = [];
  const rejected: Landed["rejected"] = [];
  const since = addDays(today, -REPEAT_DAYS);
  for (const c of inputs) {
    const m = byKey.get(c.market);
    if (!m) {
      rejected.push({ market: c.market, reason: "not a live market in this scan" });
      continue;
    }
    if (btc == null) {
      rejected.push({ market: c.market, reason: "no BTC mark to grade against" });
      continue;
    }
    const prior = [...file.calls, ...landed].find((p) => p.market === c.market && p.stance === c.stance && p.date >= since);
    if (prior) {
      rejected.push({ market: c.market, reason: `repeat of ${prior.id}` });
      continue;
    }
    const n = [...file.calls, ...landed].filter((p) => p.date === today).length + 1;
    landed.push({ ...c, id: `${today}-${n}-${c.market}`, date: today, at, mark: m.mark, btc, rel: {} });
  }
  return { file: { calls: [...file.calls, ...landed] }, landed, rejected };
}

/** Fills each call's `rel[h]` once a snapshot h days later exists. Already graded horizons are kept as they are. */
export function gradeCalls(file: RadarCallsFile, state: RadarState): RadarCallsFile {
  const days = [...state.days].sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    calls: file.calls.map((c) => {
      const rel = { ...c.rel };
      for (const h of RADAR_HORIZONS) {
        if (rel[String(h)] != null) continue;
        const target = addDays(c.date, h);
        const day = days.find((d) => d.date >= target && d.date <= addDays(target, GRADE_SLACK_DAYS));
        const mark = day?.marks[c.market]?.[0];
        const btc = day?.marks["BTC"]?.[0];
        if (!mark || !btc) continue;
        const raw = ((mark / c.mark) / (btc / c.btc) - 1) * 100;
        rel[String(h)] = Math.round((c.stance === "fade" ? -raw : raw) * 100) / 100;
      }
      return { ...c, rel };
    }),
  };
}

/** One line per stance with graded calls: count, mean move vs BTC and the share that went the called way. */
export function scorecard(file: RadarCallsFile): string[] {
  const out: string[] = [];
  for (const stance of ["ride", "fade", "watch"] as const)
    for (const h of RADAR_HORIZONS) {
      const xs = file.calls.filter((c) => c.stance === stance).map((c) => c.rel[String(h)]).filter((x): x is number => x != null);
      if (!xs.length) continue;
      const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
      const right = xs.filter((x) => x > 0).length;
      // A watch has no direction, so only its average move is shown.
      const way = stance === "watch" ? "" : ` · ${right}/${xs.length} went the called way`;
      out.push(`${stance} +${h}d vs BTC: n=${xs.length} · mean ${mean >= 0 ? "+" : ""}${mean.toFixed(1)}%${way}`);
    }
  return out.length ? out : ["no graded calls yet"];
}
