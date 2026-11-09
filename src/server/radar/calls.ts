import { RADAR_HORIZONS, type RadarCall, type RadarCallInput, type RadarCallsFile, type RadarState } from "../../shared/radar.js";
import { line, moveSince, type RadarMarket } from "./scan.js";

// The radar's call ledger (ROUTINE.md §3): the session proposes, code stamps prices, rejects what it cannot
// check, writes the push lines, grades every call against BTC at fixed horizons and reports a crossed kill
// level once. Pure: scripts/radar.ts does the I/O.

/** A call on the same market and direction within this many days is a repeat, not news. */
export const REPEAT_DAYS = 3;
/** ROUTINE.md §3.1: a cause is news from the last 3 days or an event in the next 14. */
export const CAUSE_MAX_AGE_DAYS = 3;
export const CAUSE_MAX_AHEAD_DAYS = 14;
/** Kill levels are watched this long after a call. */
export const KILL_WATCH_DAYS = 7;
/** A horizon grade accepts a snapshot up to this many days late (missed runs). */
const GRADE_SLACK_DAYS = 2;

const DAY_MS = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

export interface LandedCall {
  call: RadarCall;
  /** Distance from the mark to the kill level, % of the mark. */
  riskPct: number;
  /** Move since the cause date when memory reaches back that far (null for a future event or no memory). */
  since: { fromDate: string; pct: number; vsBtcPct: number } | null;
  line: string;
}

export interface Landed {
  file: RadarCallsFile;
  landed: LandedCall[];
  rejected: { market: string; reason: string }[];
}

export function landCalls(inputs: RadarCallInput[], markets: RadarMarket[], state: RadarState, file: RadarCallsFile, today: string, at: string): Landed {
  const byKey = new Map(markets.map((m) => [m.key, m]));
  const btc = byKey.get("BTC")?.mark;
  const landed: LandedCall[] = [];
  const rejected: Landed["rejected"] = [];
  const reject = (market: string, reason: string) => rejected.push({ market, reason });
  for (const c of inputs) {
    const m = byKey.get(c.market);
    if (!m) {
      reject(c.market, "not a live market in this scan");
      continue;
    }
    if (c.market === "BTC" || btc == null) {
      reject(c.market, "calls are graded against BTC, so BTC itself cannot be called");
      continue;
    }
    if (c.cause_date < addDays(today, -CAUSE_MAX_AGE_DAYS) || c.cause_date > addDays(today, CAUSE_MAX_AHEAD_DAYS)) {
      reject(c.market, `cause dated ${c.cause_date} is outside ${CAUSE_MAX_AGE_DAYS} days back to ${CAUSE_MAX_AHEAD_DAYS} days ahead`);
      continue;
    }
    if (c.direction === "long" ? c.kill_price >= m.mark : c.kill_price <= m.mark) {
      reject(c.market, `kill ${c.kill_price} is on the wrong side of the mark ${m.mark} for a ${c.direction}`);
      continue;
    }
    const all = [...file.calls, ...landed.map((l) => l.call)];
    const prior = all.find((p) => p.market === c.market && p.direction === c.direction && p.date >= addDays(today, -REPEAT_DAYS));
    if (prior) {
      reject(c.market, `repeat of ${prior.id}`);
      continue;
    }
    const n = all.filter((p) => p.date === today).length + 1;
    const call: RadarCall = { ...c, id: `${today}-${n}-${c.market}`, date: today, at, mark: m.mark, btc, rel: {}, killed_at: null };
    const riskPct = (Math.abs(m.mark - c.kill_price) / m.mark) * 100;
    const since = c.cause_date < today ? moveSince(state, m, btc, c.cause_date) : null;
    const head = `${landed.length + 1}. ${c.market} · ${c.stance} ${c.direction} · ${c.kind} · cause ${hostOf(c.cause_url)} ${c.cause_date}`;
    const nums = `   mark ${m.mark} · 24h ${m.chg24hPct == null ? "n/a" : signed(m.chg24hPct)}${since ? ` · since ${since.fromDate} ${signed(since.pct)} (${signed(since.vsBtcPct)} vs BTC)` : ""} · fund ${m.fundingApr.toFixed(0)}% APR · kill ${c.kill_price} (${riskPct.toFixed(1)}% away)`;
    landed.push({ call, riskPct, since, line: `${head}\n${nums}\n   ${c.thesis.slice(0, 200)}` });
  }
  return { file: { calls: [...file.calls, ...landed.map((l) => l.call)] }, landed, rejected };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

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
        rel[String(h)] = Math.round((c.direction === "short" ? -raw : raw) * 100) / 100;
      }
      return { ...c, rel };
    }),
  };
}

/** Calls from the last KILL_WATCH_DAYS whose kill level the scan's mark has crossed, stamped once. */
export function checkKills(file: RadarCallsFile, markets: RadarMarket[], today: string): { file: RadarCallsFile; killed: string[] } {
  const byKey = new Map(markets.map((m) => [m.key, m]));
  const killed: string[] = [];
  const calls = file.calls.map((c) => {
    if (c.killed_at || c.date < addDays(today, -KILL_WATCH_DAYS)) return c;
    const m = byKey.get(c.market);
    if (!m || (c.direction === "long" ? m.mark > c.kill_price : m.mark < c.kill_price)) return c;
    killed.push(`KILLED ${c.id}: ${c.market} ${c.direction} kill ${c.kill_price}, mark now ${m.mark} (${c.kill_if})\n   ${line(m)}`);
    return { ...c, killed_at: today };
  });
  return { file: { calls }, killed };
}

export interface ScoreRow {
  stance: "ride" | "fade";
  horizonDays: number;
  n: number;
  /** Mean move vs BTC, %. */
  meanPct: number;
  /** Calls that went the called way. */
  hits: number;
}

/** Per stance and horizon with graded calls: count, mean move vs BTC, how many went the called way. */
export function scorecardRows(file: RadarCallsFile): ScoreRow[] {
  const out: ScoreRow[] = [];
  for (const stance of ["ride", "fade"] as const)
    for (const h of RADAR_HORIZONS) {
      const xs = file.calls.filter((c) => c.stance === stance).map((c) => c.rel[String(h)]).filter((x): x is number => x != null);
      if (!xs.length) continue;
      out.push({ stance, horizonDays: h, n: xs.length, meanPct: xs.reduce((s, x) => s + x, 0) / xs.length, hits: xs.filter((x) => x > 0).length });
    }
  return out;
}

/** One line per scorecardRows row. */
export function scorecard(file: RadarCallsFile): string[] {
  const out = scorecardRows(file).map((r) => `${r.stance} +${r.horizonDays}d vs BTC: n=${r.n} · mean ${signed(r.meanPct)} · ${r.hits}/${r.n} went the called way`);
  return out.length ? out : ["no graded calls yet"];
}
