import { z } from "zod";
import { zScore } from "../desk/analytics.js";
import { calendarEvents, type MacroKind } from "../intel/calendar.js";
import { LLAMA_STABLES_URL, parseStablecoinChart } from "../lab/providers/llama.js";
import { mapLimit } from "../lab/util.js";

// The radar's keyless macro block (ROUTINE.md §1): Fed policy and funding rates, the Treasury curve, Fed net
// liquidity, the dollar, credit and vol stress, stablecoin supply, other central banks, the last CPI and NFP
// prints, the macro calendar and the market's odds for the next FOMC. Sources: FRED fredgraph CSV (one series
// per request), the Treasury's Daily Treasury Statement, Yahoo's chart API, Polymarket's gamma API, DefiLlama.
// Every change and z-score runs over the series' own history, so nothing is stored and `--save` stays HL-only.
// A failed source is a gap line, never a crash. No response text reaches the digest: only numbers, dates and
// labels built here.

export const MACRO = {
  /** History fetched for daily and weekly FRED series (z over a year, 13w changes). */
  fredDays: 400,
  /** Monthly series: the prior month's YoY needs 14 months. */
  monthlyDays: 480,
  timeoutMs: 8_000,
  concurrency: 8,
  calendarDays: 14,
  /** Days since a series' last observation past which it prints STALE; a FRED_MACRO entry can set its own. */
  staleDays: { daily: 5, weekly: 12, monthly: 70 },
  /** Risk-off tells (ROUTINE.md §3 condition 5). Change only in a dev PR, with the radar scorecard as evidence. */
  tells: { netLiq4wB: 0, hyWiden4wBp: 25, volZ: 2, dxy4wPct: 2, fomcMoveProb: 0.6 },
} as const;

type Cadence = keyof typeof MACRO.staleDays;

/**
 * FRED series by id, with their cadence and the unit FRED publishes them in. A monthly point is dated the 1st of
 * its month, so a series released late in the month after next sets `staleDays` past its normal age.
 */
export const FRED_MACRO = {
  DFEDTARU: { cadence: "daily", unit: "%" }, // Fed funds target range, upper
  DFEDTARL: { cadence: "daily", unit: "%" }, // lower
  EFFR: { cadence: "daily", unit: "%" },
  IORB: { cadence: "daily", unit: "%" },
  SOFR: { cadence: "daily", unit: "%" },
  DGS2: { cadence: "daily", unit: "%" },
  DGS10: { cadence: "daily", unit: "%" },
  DFII10: { cadence: "daily", unit: "%" }, // 10Y TIPS (real) yield
  T10Y2Y: { cadence: "daily", unit: "pp" },
  WALCL: { cadence: "weekly", unit: "$M" }, // Fed total assets, Wednesday level
  WDTGAL: { cadence: "weekly", unit: "$M" }, // TGA, Wednesday level
  RRPONTSYD: { cadence: "daily", unit: "$B" }, // overnight reverse repo
  WRBWFRBL: { cadence: "weekly", unit: "$M" }, // reserve balances, Wednesday level (WRESBAL is the week average)
  BAMLH0A0HYM2: { cadence: "daily", unit: "%" }, // ICE BofA US high yield OAS
  ECBASSETSW: { cadence: "weekly", unit: "€M" },
  JPNASSETS: { cadence: "monthly", unit: "¥100M", staleDays: 80 }, // out ~5 weeks after its date: up to ~70 days old
  M2SL: { cadence: "monthly", unit: "$B", staleDays: 95 }, // H.6, fourth Tuesday of the next month: up to ~89 days old
  CPIAUCSL: { cadence: "monthly", unit: "index", staleDays: 80 }, // up to ~75 days old on release day
  CPILFESL: { cadence: "monthly", unit: "index", staleDays: 80 },
  PAYEMS: { cadence: "monthly", unit: "thousands" },
  UNRATE: { cadence: "monthly", unit: "%" },
} as const satisfies Record<string, { cadence: Cadence; unit: string; staleDays?: number }>;
export type FredMacroId = keyof typeof FRED_MACRO;

export const YAHOO_MACRO = ["^TNX", "DX-Y.NYB", "^VIX", "^MOVE"] as const;
export type YahooMacroSymbol = (typeof YAHOO_MACRO)[number];

const TGA_CLOSING = "Treasury General Account (TGA) Closing Balance";
export const DTS_TGA_URL = `https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance?sort=-record_date&page%5Bsize%5D=10&fields=record_date,account_type,open_today_bal&filter=account_type:eq:${encodeURIComponent(TGA_CLOSING)}`;
/** Open fed-rates events ending on or after the FOMC, soonest first: without the floor, year-end events crowd it out. */
export const polymarketFedUrl = (fomcDate: string) =>
  `https://gamma-api.polymarket.com/events?limit=20&closed=false&tag_slug=fed-rates&order=endDate&ascending=true&end_date_min=${fomcDate}`;

export interface Point {
  date: string;
  value: number;
}

export interface MacroGap {
  source: string;
  reason: string;
}

const DAY = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const msOf = (date: string) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date: string, n: number) => day(msOf(date) + n * DAY);
const addMonths = (date: string, n: number) => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return day(d.getTime());
};
const finite = (x: unknown): number | null => {
  const n = typeof x === "string" ? Number(x) : x;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

// ─── transport (also used by routine/collect.ts) ───

export class FetchError extends Error {
  constructor(
    readonly status: number | string,
    message: string,
  ) {
    super(message);
  }
}

export const errStatus = (e: unknown): number | string => (e instanceof FetchError ? e.status : e instanceof Error && e.name === "TimeoutError" ? "timeout" : "error");
/**
 * A gap's detail is a short reason we wrote, never response text: it reaches the prompt, so an upstream body
 * (or a zod message quoting a received value) must not. Transport errors keep the runtime's own message.
 */
export const errDetail = (e: unknown): string => {
  if (e instanceof FetchError) return e.message;
  if (e instanceof z.ZodError) return `unexpected response shape at ${[...new Set(e.issues.map((i) => i.path.join(".") || "(root)"))].slice(0, 5).join(", ")}`;
  if (e instanceof Error && e.name === "TimeoutError") return "timed out";
  return (e instanceof Error ? e.message : String(e)).replace(/[^\w .:/()-]/g, "").slice(0, 120);
};

export async function fetchText(f: typeof fetch, url: string, init: RequestInit = {}, timeoutMs: number = MACRO.timeoutMs): Promise<string> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new FetchError(res.status, `HTTP ${res.status}`);
  return text;
}
export async function fetchJson(f: typeof fetch, url: string, init: RequestInit = {}, timeoutMs: number = MACRO.timeoutMs): Promise<unknown> {
  const text = await fetchText(f, url, init, timeoutMs);
  try {
    return JSON.parse(text);
  } catch {
    throw new FetchError("bad-json", "response is not JSON");
  }
}

// ─── parsers ───

/** FRED fredgraph CSV → points. FRED marks a day without a print with "" (or "." in older files); both are skipped. */
export function parseFredCsv(csv: string, id?: string): Point[] {
  const [header = "", ...rows] = csv.trim().split(/\r?\n/);
  const [dateCol, idCol, ...rest] = header.split(",");
  if (dateCol !== "observation_date" || !idCol || rest.length || (id !== undefined && idCol !== id)) throw new FetchError("bad-csv", "not a FRED CSV for the series");
  const out: Point[] = [];
  for (const line of rows) {
    const [date, raw = ""] = line.split(",");
    const value = raw.trim() === "" || raw.trim() === "." ? null : finite(raw);
    if (date && ISO_DATE.test(date) && value !== null) out.push({ date, value });
  }
  return out;
}

/** One series per request (several ids return a ZIP). No user-agent header: fredgraph stalls custom ones. */
export async function fetchFred(f: typeof fetch, id: string, now: Date, days: number, timeoutMs: number = MACRO.timeoutMs): Promise<Point[]> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${day(now.getTime() - days * DAY)}`;
  let csv: string;
  try {
    csv = await fetchText(f, url, {}, timeoutMs);
  } catch (e) {
    // An HTTP answer or a stall: no retry (a stalled series would cost the timeout twice).
    if (e instanceof FetchError || (e instanceof Error && e.name === "TimeoutError")) throw e;
    // Transport error (FRED's HTTP/2 edge resets streams): one retry on a fresh, non-reused connection.
    csv = await fetchText(f, url, { headers: { connection: "close" } }, timeoutMs);
  }
  const points = parseFredCsv(csv, id);
  if (!points.length) throw new FetchError("empty", "no observations in the window");
  return points;
}

const YahooChart = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({ regularMarketPrice: z.number().nullable().optional(), regularMarketTime: z.number().nullable().optional() }).passthrough(),
          timestamp: z.array(z.number()).optional(),
          indicators: z.object({ quote: z.array(z.object({ close: z.array(z.number().nullable()).optional() }).passthrough()) }),
        }),
      )
      .min(1),
  }),
});

export interface YahooQuote {
  price: number | null;
  /** ISO time of `price`. */
  time: string | null;
  /** Daily closes by UTC date; the last bar is the session in progress. */
  closes: Point[];
}

/** Yahoo v8 chart. It answers 429 without a browser user-agent. */
export async function fetchYahoo(f: typeof fetch, sym: string, range: string, timeoutMs: number = MACRO.timeoutMs): Promise<YahooQuote> {
  const raw = await fetchJson(f, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`, { headers: { "user-agent": "Mozilla/5.0" } }, timeoutMs);
  const res = YahooChart.parse(raw).chart.result[0]!;
  const ts = res.timestamp ?? [];
  const closes = res.indicators.quote[0]?.close ?? [];
  const points: Point[] = [];
  ts.forEach((t, i) => {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) points.push({ date: day(t * 1000), value: c });
  });
  const time = finite(res.meta.regularMarketTime);
  return { price: finite(res.meta.regularMarketPrice), time: time === null ? null : new Date(time * 1000).toISOString(), closes: points };
}

const DtsResponse = z.object({ data: z.array(z.object({ record_date: z.string().regex(ISO_DATE), account_type: z.string(), open_today_bal: z.string() })) });

/** Daily Treasury Statement → TGA closing balance in $M, ascending. The closing row carries it in open_today_bal. */
export function parseDtsTga(json: unknown): Point[] {
  return DtsResponse.parse(json)
    .data.flatMap((r) => {
      const value = r.account_type === TGA_CLOSING && r.open_today_bal.trim() ? finite(r.open_today_bal) : null;
      return value === null ? [] : [{ date: r.record_date, value }];
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export type OddsLabel = "hold" | "+25bp" | "+50bp" | "-25bp" | "-50bp";
const ODDS_LABELS: Array<[RegExp, OddsLabel]> = [
  [/^no change$/i, "hold"],
  [/^25 ?bps? increase$/i, "+25bp"],
  [/^50\+? ?bps? increase$/i, "+50bp"],
  [/^25 ?bps? decrease$/i, "-25bp"],
  [/^50\+? ?bps? decrease$/i, "-50bp"],
];

export interface FedOdds {
  volumeUsd: number | null;
  /** Yes price per outcome, highest first. */
  outcomes: Array<{ label: OddsLabel; p: number }>;
  hike: number;
  cut: number;
}

/** Polymarket encodes outcomes and their prices as JSON strings inside the JSON. */
const jsonString = z.string().transform((s, ctx) => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "not JSON" });
    return z.NEVER;
  }
});
const probability = z.string().regex(/^\d+(\.\d+)?$/).transform(Number).pipe(z.number().max(1));
const OddsMarket = z.object({
  groupItemTitle: z.string().optional(),
  outcomes: jsonString.pipe(z.tuple([z.literal("Yes"), z.literal("No")])).optional(),
  outcomePrices: jsonString.pipe(z.tuple([probability, probability])),
  closed: z.boolean().optional(),
});
const PolyEvents = z.array(z.object({ title: z.string(), endDate: z.string().optional(), volume: z.union([z.number(), z.string()]).optional(), markets: z.array(z.unknown()).optional() }));

/**
 * The "Fed Decision in <Month>?" event for the FOMC on `fomcDate` (combo and yearly markets are other events),
 * ending on or after that day. Outcome labels come from a fixed set; an unrecognised outcome is dropped. Null
 * when no such event is open.
 */
export function parseFedOdds(json: unknown, fomcDate: string): FedOdds | null {
  const title = new RegExp(`^Fed Decision in ${MONTHS[Number(fomcDate.slice(5, 7)) - 1]}\\?$`, "i");
  const event = PolyEvents.parse(json)
    .filter((e) => title.test(e.title) && e.endDate !== undefined && e.endDate.slice(0, 10) >= fomcDate)
    .sort((a, b) => (a.endDate! < b.endDate! ? -1 : 1))[0];
  if (!event) return null;
  const outcomes = z
    .array(OddsMarket)
    .parse(event.markets ?? [])
    .flatMap((mk) => {
      const label = ODDS_LABELS.find(([re]) => re.test(mk.groupItemTitle ?? ""))?.[1];
      return label && !mk.closed ? [{ label, p: mk.outcomePrices[0] }] : [];
    })
    .sort((a, b) => b.p - a.p);
  if (!outcomes.length) return null;
  const sum = (sign: string) => outcomes.filter((o) => o.label.startsWith(sign)).reduce((s, o) => s + o.p, 0);
  return { volumeUsd: finite(event.volume), outcomes, hike: sum("+"), cut: sum("-") };
}

// ─── derivations (pure) ───

/** The last point on or before `date` (series ascending). */
export function valueAt(series: Point[], date: string): Point | null {
  let out: Point | null = null;
  for (const p of series) {
    if (p.date > date) break;
    out = p;
  }
  return out;
}

const baseOf = (series: Point[], days: number) => {
  const last = series.at(-1);
  return last ? valueAt(series, addDays(last.date, -days)) : null;
};
/** Last value minus the value `days` before the series' own last date (on or before); null without that history. */
export function change(series: Point[], days: number): number | null {
  const base = baseOf(series, days);
  return base ? series.at(-1)!.value - base.value : null;
}
export function pctChange(series: Point[], days: number): number | null {
  const base = baseOf(series, days);
  return base && base.value ? (series.at(-1)!.value / base.value - 1) * 100 : null;
}

const atMonth = (series: Point[], date: string) => series.find((p) => p.date === date) ?? null;
/** Percent change over `months` between exact monthly observations ending at `date`; null when either month is missing. */
export function monthChange(series: Point[], months: number, date = series.at(-1)?.date): number | null {
  const now = date ? atMonth(series, date) : null;
  const then = date ? atMonth(series, addMonths(date, -months)) : null;
  return now && then && then.value ? (now.value / then.value - 1) * 100 : null;
}
/** v[t] / v[t - 12 months] - 1, in percent; a missing base month is null, never the nearest one. */
export const yoy = (series: Point[], date?: string) => monthChange(series, 12, date);

/** The latest change in a step series (the Fed's target): its first day and size in bp. */
export function lastMove(series: Point[]): { date: string; bp: number } | null {
  for (let i = series.length - 1; i > 0; i--) {
    const d = series[i]!.value - series[i - 1]!.value;
    if (Math.abs(d) > 1e-9) return { date: series[i]!.date, bp: Math.round(d * 100) };
  }
  return null;
}

/**
 * Fed net liquidity in $B. Units (collectors/fred.ts deriveMetrics, from marketstate): WALCL and the TGA are
 * millions of dollars, RRPONTSYD is billions; normalise to billions before combining.
 */
export const netLiquidityB = (walclM: number, tgaM: number, rrpB: number) => walclM / 1000 - tgaM / 1000 - rrpB;

/** Net liquidity on each WALCL Wednesday: the TGA of that same Wednesday and the RRP print on or before it. */
export function netLiquidity(walcl: Point[], tga: Point[], rrp: Point[]): Point[] {
  return walcl.flatMap((w) => {
    const t = tga.find((p) => p.date === w.date);
    const r = valueAt(rrp, w.date);
    return t && r ? [{ date: w.date, value: netLiquidityB(w.value, t.value, r.value) }] : [];
  });
}

/** z of `x` against the series' points in the year before `date`. */
const z1y = (series: Point[], x: number, date: string) =>
  zScore(
    x,
    series.filter((p) => p.date < date && p.date >= addDays(date, -365)).map((p) => p.value),
  );

/** A Yahoo quote as a series ending in the live price, so changes and z run against it. */
function live(q: YahooQuote | undefined) {
  if (!q) return null;
  const close = q.closes.at(-1);
  const price = q.price ?? close?.value ?? null;
  const date = q.price !== null && q.time ? q.time.slice(0, 10) : close?.date;
  if (price === null || !date) return null;
  const series = [...q.closes.filter((p) => p.date < date), { date, value: price }];
  return { price, date, time: q.price !== null && q.time ? q.time.slice(11, 16) : null, series, z: z1y(series, price, date) };
}

// ─── collection ───

export interface MacroData {
  fred: Partial<Record<FredMacroId, Point[]>>;
  yahoo: Partial<Record<YahooMacroSymbol, YahooQuote>>;
  /** Daily Treasury Statement TGA, $M. */
  tga: Point[] | null;
  /** Polymarket's odds for the next FOMC. */
  odds: FedOdds | null;
  /** Total USD-pegged stablecoin supply, USD; the last day is partial. */
  stables: Point[] | null;
  gaps: MacroGap[];
}

/** FOMC, CPI and NFP releases from the start of today (UTC), so a print earlier today still shows. */
export function macroCalendar(now: Date): Array<{ kind: MacroKind; date: string; at: string }> {
  return calendarEvents(now, new Date(`${day(now.getTime())}T00:00:00Z`)).flatMap((e) => {
    const [, kind, date] = e.key.split(":");
    return e.scheduledAt && kind && date ? [{ kind: kind as MacroKind, date, at: e.scheduledAt }] : [];
  });
}

/** The next FOMC decision after `now`; one decided earlier today is past, and its odds are settled. */
const nextFomc = (now: Date) => macroCalendar(now).find((e) => e.kind === "fomc" && Date.parse(e.at) > now.getTime());

const nonEmpty = <T,>(xs: T[], why: string): T[] => {
  if (!xs.length) throw new FetchError("empty", why);
  return xs;
};

/** About 28 keyless requests, `MACRO.concurrency` at a time. Never throws: a failed source becomes a gap. */
export async function collectMacro(f: typeof fetch, now: Date): Promise<MacroData> {
  const m: MacroData = { fred: {}, yahoo: {}, tga: null, odds: null, stables: null, gaps: [] };
  const fomc = nextFomc(now);
  const jobs: Array<[string, () => Promise<void>]> = [
    ...(Object.keys(FRED_MACRO) as FredMacroId[]).map((id): [string, () => Promise<void>] => [
      `fred.${id}`,
      async () => {
        m.fred[id] = await fetchFred(f, id, now, FRED_MACRO[id].cadence === "monthly" ? MACRO.monthlyDays : MACRO.fredDays);
      },
    ]),
    ...YAHOO_MACRO.map((sym): [string, () => Promise<void>] => [
      `yahoo.${sym}`,
      async () => {
        m.yahoo[sym] = await fetchYahoo(f, sym, "1y");
      },
    ]),
    [
      "treasury.dts",
      async () => {
        m.tga = nonEmpty(parseDtsTga(await fetchJson(f, DTS_TGA_URL)), "no TGA closing balance");
      },
    ],
    [
      "polymarket",
      async () => {
        if (!fomc) throw new FetchError("no-fomc", "no next FOMC in intel/calendar.ts");
        m.odds = parseFedOdds(await fetchJson(f, polymarketFedUrl(fomc.date)), fomc.date);
        if (!m.odds) throw new FetchError("no-event", `no open Fed Decision event for ${fomc.date}`);
      },
    ],
    [
      "defillama.stablecoins",
      async () => {
        const s = parseStablecoinChart(await fetchJson(f, LLAMA_STABLES_URL));
        m.stables = nonEmpty(
          s.t.map((t, i) => ({ date: day(t), value: s.v[i]! })),
          "no rows",
        );
      },
    ],
  ];
  const failed = await mapLimit(jobs, MACRO.concurrency, async ([source, run]): Promise<MacroGap | null> => {
    try {
      await run();
      return null;
    } catch (e) {
      return { source, reason: errDetail(e) };
    }
  });
  m.gaps = failed.filter((g): g is MacroGap => g !== null);
  return m;
}

// ─── text for the session ───

const signed = (x: number, dp = 0, unit = "") => {
  const s = Math.abs(x).toFixed(dp);
  return `${x < 0 && Number(s) !== 0 ? "-" : "+"}${s}${unit}`;
};
const na = <T,>(x: T | null | undefined, show: (v: T) => string) => (x == null ? "n/a" : show(x));
/** A change in percentage points, in bp. */
const bp = (pp: number | null, unit = "bp") => na(pp, (v) => signed(v * 100, 0, unit));
const pc = (x: number | null, dp = 2) => na(x, (v) => signed(v, dp, "%"));
const zf = (x: number | null) => na(x, (v) => signed(v, 2));
const prob = (p: number) => `${(p * 100).toFixed(1)}%`;
const usdB = (b: number) => (Math.abs(b) >= 1000 ? `$${(b / 1000).toFixed(3)}T` : `$${b.toFixed(1)}B`);
const dUsdB = (b: number | null) => na(b, (v) => `${v < 0 && Math.abs(v) >= 0.05 ? "-" : "+"}${usdB(Math.abs(v))}`);
const usdShort = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}k`);
const toB = (s: Point[], per: number) => s.map((p) => ({ date: p.date, value: p.value / per }));

export interface Tell {
  on: boolean | null;
  text: string;
}

const tell = (name: string, x: number | null, on: (x: number) => boolean, show: (x: number) => string, rule: [on: string, off: string]): Tell =>
  x === null ? { on: null, text: name } : { on: on(x), text: `${name} ${show(x)} (${on(x) ? rule[0] : rule[1]})` };

/** The five risk-off conditions (MACRO.tells); `on: null` when an input is missing. */
export function macroTells(m: MacroData): Tell[] {
  const T = MACRO.tells;
  const { WALCL, WDTGAL, RRPONTSYD, BAMLH0A0HYM2 } = m.fred;
  const nl = WALCL && WDTGAL && RRPONTSYD ? netLiquidity(WALCL, WDTGAL, RRPONTSYD) : [];
  const hy = BAMLH0A0HYM2 ? change(BAMLH0A0HYM2, 28) : null;
  const vix = live(m.yahoo["^VIX"])?.z ?? null;
  const move = live(m.yahoo["^MOVE"])?.z ?? null;
  const dxy = live(m.yahoo["DX-Y.NYB"]);
  const zs = [vix, move].filter((x): x is number => x !== null);
  return [
    tell("net liq 4w", change(nl, 28), (x) => x < T.netLiq4wB, dUsdB, [`< ${T.netLiq4wB}`, `>= ${T.netLiq4wB}`]),
    tell("HY OAS 4w", hy === null ? null : hy * 100, (x) => x >= T.hyWiden4wBp, (x) => signed(x, 0, "bp"), [`>= +${T.hyWiden4wBp}bp`, `< +${T.hyWiden4wBp}bp`]),
    tell("VIX/MOVE z1y", zs.length ? Math.max(...zs) : null, (x) => x >= T.volZ, () => `${zf(vix)}/${zf(move)}`, [`>= ${T.volZ}`, `< ${T.volZ}`]),
    tell("DXY 4w", dxy ? pctChange(dxy.series, 28) : null, (x) => x >= T.dxy4wPct, (x) => pc(x, 1), [`>= +${T.dxy4wPct}%`, `< +${T.dxy4wPct}%`]),
    tell("FOMC hike", m.odds?.hike ?? null, (x) => x >= T.fomcMoveProb, prob, [`>= ${T.fomcMoveProb * 100}%`, `< ${T.fomcMoveProb * 100}%`]),
  ];
}

interface Item {
  text: string;
  /** As-of label; printed once after the last of a run of items that share it. */
  at?: string;
}
const joinItems = (items: Item[]) => items.map((x, i) => (x.at && x.at !== items[i + 1]?.at ? `${x.text} [${x.at}]` : x.text)).join(" · ");

/**
 * The digest's macro section, one line per topic: every value carries its as-of date (`[10-29]` dates the items
 * before it on the line), a series past its cadence prints STALE, a missing value prints n/a, and the last line
 * names the sources that failed.
 */
export function macroLines(m: MacroData, now: Date): string[] {
  const today = day(now.getTime());
  const near = (d: string) => Math.abs(msOf(d) - msOf(today)) < 300 * DAY;
  const md = (d: string) => (near(d) ? d.slice(5) : d);
  const mon = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]!.slice(0, 3)}${near(d) ? "" : ` ${d.slice(0, 4)}`}`;
  const stale = (d: string, c: Cadence, limit: number = MACRO.staleDays[c]) => ((msOf(today) - msOf(d)) / DAY > limit ? " STALE" : "");
  const asOf = (d: string, c: Cadence, limit?: number) => `${c === "monthly" ? mon(d) : md(d)}${stale(d, c, limit)}`;
  const F = m.fred;
  const series = (id: FredMacroId) => (F[id]?.length ? F[id]! : null);
  const tagOf = (id: FredMacroId) => {
    const spec: { cadence: Cadence; staleDays?: number } = FRED_MACRO[id];
    return asOf(F[id]!.at(-1)!.date, spec.cadence, spec.staleDays);
  };
  const quoteAt = (q: NonNullable<ReturnType<typeof live>>) => `${md(q.date)}${q.time ? ` ${q.time}Z` : ""}${stale(q.date, "daily")}`;
  const row = (label: string, body: string) => `${label.padEnd(10)}${body}`;

  // policy
  const up = series("DFEDTARU");
  const lo = series("DFEDTARL");
  const moved = up && lastMove(up);
  const rate = (id: FredMacroId, name: string): Item => (series(id) ? { text: `${name} ${F[id]!.at(-1)!.value.toFixed(2)}`, at: tagOf(id) } : { text: `${name} n/a` });
  const sofr = series("SOFR")?.at(-1);
  const iorbThen = sofr && series("IORB") ? valueAt(F.IORB!, sofr.date) : null;
  const policy = joinItems([
    up && lo
      ? {
          text: `Fed funds ${lo.at(-1)!.value.toFixed(2)}-${up.at(-1)!.value.toFixed(2)} (${moved ? `last move ${signed(moved.bp, 0, "bp")} eff ${md(moved.date)}` : `no move since ${md(up[0]!.date)}`})`,
          at: tagOf("DFEDTARU"),
        }
      : { text: "Fed funds n/a" },
    rate("EFFR", "EFFR"),
    rate("IORB", "IORB"),
    rate("SOFR", "SOFR"),
    sofr && iorbThen ? { text: `SOFR-IORB ${bp(sofr.value - iorbThen.value)}`, at: tagOf("SOFR") } : { text: "SOFR-IORB n/a" },
  ]);

  // FOMC and the calendar
  const cal = macroCalendar(now);
  const when = (e: { at: string }) => {
    const days = Math.round((msOf(e.at.slice(0, 10)) - msOf(today)) / DAY);
    return `${WEEKDAYS[new Date(e.at).getUTCDay()]} ${md(e.at.slice(0, 10))} ${e.at.slice(11, 16)}Z (${days ? `${days}d` : "today"})`;
  };
  const fomc = nextFomc(now);
  const o = m.odds;
  const odds = o
    ? `Polymarket (${o.volumeUsd === null ? "volume n/a" : usdShort(o.volumeUsd)}): ${o.outcomes.map((x) => `${x.label} ${prob(x.p)}`).join(" · ")} (hike ${prob(o.hike)}, cut ${prob(o.cut)})`
    : "Polymarket n/a";
  const horizon = now.getTime() + MACRO.calendarDays * DAY;
  const soon = cal.filter((e) => Date.parse(e.at) <= horizon);
  const calendar = [
    ...soon.map((e) => `${e.kind.toUpperCase()} ${when(e)}`),
    ...(soon.some((e) => e.kind === "fomc") ? [] : [`no FOMC in ${MACRO.calendarDays}d`]),
  ].join(" · ");

  // yields
  const level = (id: FredMacroId, name: string, labelled = false): Item => {
    const s = series(id);
    if (!s) return { text: `${name} n/a` };
    const [c1, c4] = [change(s, 7), change(s, 28)];
    return { text: `${name} ${s.at(-1)!.value.toFixed(2)} (${labelled ? `1w ${bp(c1)}, 4w ${bp(c4)}` : `${bp(c1, "")}, ${bp(c4, "")}`})`, at: tagOf(id) };
  };
  const nom = series("DGS10");
  const real = series("DFII10");
  const beDate = nom && real ? [nom.at(-1)!.date, real.at(-1)!.date].sort()[0]! : null;
  const [beNom, beReal] = beDate ? [valueAt(nom!, beDate), valueAt(real!, beDate)] : [null, null];
  const curve = series("T10Y2Y");
  const yields = joinItems([
    level("DGS2", "2Y", true),
    level("DGS10", "10Y"),
    level("DFII10", "real 10Y"),
    beNom && beReal ? { text: `breakeven ${(beNom.value - beReal.value).toFixed(2)}`, at: asOf(beDate!, "daily") } : { text: "breakeven n/a" },
    curve ? { text: `2s10s ${bp(curve.at(-1)!.value)} (${bp(change(curve, 7), "")}, ${bp(change(curve, 28), "")})`, at: tagOf("T10Y2Y") } : { text: "2s10s n/a" },
  ]);
  const tnx = live(m.yahoo["^TNX"]);
  const tenLive = tnx ? `${tnx.price.toFixed(2)} (^TNX ${quoteAt(tnx)}; 1w ${bp(change(tnx.series, 7))}, 4w ${bp(change(tnx.series, 28))})` : "n/a";

  // liquidity
  const W = series("WALCL");
  const G = series("WDTGAL");
  const R = series("RRPONTSYD");
  const nl = W && G && R ? netLiquidity(W, G, R) : [];
  const wed = nl.at(-1)?.date;
  let netLiq = "n/a";
  if (wed) {
    const upTo = (s: Point[], per: number) => toB(s.filter((p) => p.date <= wed), per);
    const parts = (s: Point[]) => `${usdB(s.at(-1)!.value)} (${dUsdB(change(s, 7))}, ${dUsdB(change(s, 28))})`;
    netLiq =
      `${usdB(nl.at(-1)!.value)} (1w ${dUsdB(change(nl, 7))}, 4w ${dUsdB(change(nl, 28))}, 13w ${dUsdB(change(nl, 91))})` +
      ` = Fed assets ${parts(upTo(W!, 1000))} - TGA ${parts(upTo(G!, 1000))} - RRP ${usdB(valueAt(R!, wed)!.value)} [Wed ${asOf(wed, "weekly")}]`;
  }
  const dts = m.tga?.at(-1);
  const wedTga = wed ? G!.find((p) => p.date === wed) : undefined;
  const rrp = R?.at(-1);
  const assets = W?.at(-1);
  const nowcast = [
    dts ? `TGA ${usdB(dts.value / 1000)} [DTS ${asOf(dts.date, "daily")}]${wedTga ? ` (${dUsdB((dts.value - wedTga.value) / 1000)} vs Wed)` : ""}` : "TGA n/a",
    `${rrp ? `RRP ${usdB(rrp.value)} [${asOf(rrp.date, "daily")}]` : "RRP n/a"} -> net liq est. ${dts && rrp && assets ? `${usdB(netLiquidityB(assets.value, dts.value, rrp.value))} (mixed dates)` : "n/a"}`,
  ].join(" · ");
  const res = series("WRBWFRBL");
  const resB = res && toB(res, 1000);
  const reserves = resB ? `${usdB(resB.at(-1)!.value)} (1w ${dUsdB(change(resB, 7))}, 4w ${dUsdB(change(resB, 28))}) [${tagOf("WRBWFRBL")}]` : "n/a";

  // dollar and stress
  const dxy = live(m.yahoo["DX-Y.NYB"]);
  const dollar = dxy
    ? `DXY ${dxy.price.toFixed(2)} (1w ${pc(pctChange(dxy.series, 7), 1)}, 4w ${pc(pctChange(dxy.series, 28), 1)}, z1y ${zf(dxy.z)}) [${quoteAt(dxy)}]`
    : "DXY n/a";
  const hy = series("BAMLH0A0HYM2");
  const hyLast = hy?.at(-1);
  const vol = (sym: YahooMacroSymbol, name: string): Item => {
    const q = live(m.yahoo[sym]);
    return q ? { text: `${name} ${q.price.toFixed(1)} (4w ${na(change(q.series, 28), (v) => signed(v, 1))}, z1y ${zf(q.z)})`, at: quoteAt(q) } : { text: `${name} n/a` };
  };
  const stress = joinItems([
    hy && hyLast
      ? { text: `HY OAS ${Math.round(hyLast.value * 100)}bp (1w ${bp(change(hy, 7))}, 4w ${bp(change(hy, 28))}, z1y ${zf(z1y(hy, hyLast.value, hyLast.date))})`, at: tagOf("BAMLH0A0HYM2") }
      : { text: "HY OAS n/a" },
    vol("^VIX", "VIX"),
    vol("^MOVE", "MOVE"),
  ]);

  // stablecoins and other central banks
  const st = m.stables;
  const stLast = st?.at(-1);
  const stables =
    st && stLast
      ? `${usdB(stLast.value / 1e9)} (7d ${pc(pctChange(st, 7))}, 30d ${pc(pctChange(st, 30))}) [${md(stLast.date)}${stLast.date === today ? ", partial day" : stale(stLast.date, "daily")}]`
      : "n/a";
  const ecb = series("ECBASSETSW");
  const boj = series("JPNASSETS");
  const m2 = series("M2SL");
  const global = joinItems([
    ecb ? { text: `ECB €${(ecb.at(-1)!.value / 1e6).toFixed(3)}T (4w ${pc(pctChange(ecb, 28))}, 13w ${pc(pctChange(ecb, 91))})`, at: tagOf("ECBASSETSW") } : { text: "ECB n/a" },
    boj ? { text: `BoJ ¥${(boj.at(-1)!.value / 1e4).toFixed(1)}T (3m ${pc(monthChange(boj, 3))}, 12m ${pc(monthChange(boj, 12))})`, at: tagOf("JPNASSETS") } : { text: "BoJ n/a" },
    m2 ? { text: `US M2 $${(m2.at(-1)!.value / 1000).toFixed(2)}T (YoY ${pc(yoy(m2))})`, at: tagOf("M2SL") } : { text: "US M2 n/a" },
  ]);

  // last prints: each with the month before it
  const print = (id: FredMacroId, name: string, show: (s: Point[], date: string) => string): Item => {
    const s = series(id);
    if (!s) return { text: `${name} n/a` };
    const prev = addMonths(s.at(-1)!.date, -1);
    return { text: `${name} ${show(s, s.at(-1)!.date)} (${mon(prev)} ${show(s, prev)})`, at: tagOf(id) };
  };
  const level1 = (s: Point[], d: string) => na(atMonth(s, d)?.value, (v) => `${v.toFixed(1)}%`);
  const yoyAt = (s: Point[], d: string) => na(yoy(s, d), (v) => `${v.toFixed(2)}%`);
  const mom = (s: Point[], d: string) => {
    const [a, b] = [atMonth(s, d), atMonth(s, addMonths(d, -1))];
    return a && b ? signed(a.value - b.value, 0, "k") : "n/a";
  };
  const prints = joinItems([
    print("CPIAUCSL", "CPI YoY", yoyAt),
    print("CPILFESL", "core", yoyAt),
    print("PAYEMS", "NFP", mom),
    print("UNRATE", "unemployment", level1),
  ]);

  const tells = macroTells(m);
  const group = (on: boolean | null) => tells.filter((t) => t.on === on).map((t) => t.text);
  const [onT, offT, naT] = [group(true), group(false), group(null)];
  // Counted over the tells that have their inputs: a missing input is neither on nor off.
  const tellLine = `risk-off ${onT.length}/${onT.length + offT.length} on: ${onT.join(" · ") || "none"} | off: ${offT.join(" · ") || "none"}${naT.length ? ` | n/a: ${naT.join(" · ")}` : ""}`;

  return [
    row("policy", policy),
    row("FOMC", `${fomc ? `next ${when(fomc)}` : "next n/a (beyond intel/calendar.ts)"} · ${odds}`),
    row("yields", yields),
    row("10Y live", tenLive),
    row("net liq", netLiq),
    row("nowcast", nowcast),
    row("reserves", reserves),
    row("dollar", dollar),
    row("stress", stress),
    row("stables", stables),
    row("global", global),
    row("prints", prints),
    row("calendar", calendar),
    row("tells", tellLine),
    `macro gaps: ${m.gaps.length ? m.gaps.map((g) => `${g.source} ${g.reason}`).join("; ") : "none"}`,
  ];
}
