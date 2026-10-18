import { z } from "zod";
import { fetchCandles, fetchPerpMetaAndCtxs } from "../../shared/hl-client.js";
import type { AssetCtx, Candle } from "../../shared/types.js";
import { calendarEvents } from "../intel/calendar.js";

// Collect stage of the fallback routine (docs/fallback-routine.md, pipeline
// step 2). Every number the model sees is fetched here. Every fetch has a
// timeout, and a failure becomes a `gaps[]` entry, never a crash: the run
// goes on with what it has and says what is missing.

export interface Gap {
  source: string;
  status: number | string;
  detail: string;
}

export const MAJORS = ["BTC", "ETH", "SOL", "HYPE"] as const;
export const FRED_IDS = ["DGS10", "DGS2", "T10Y2Y", "VIXCLS", "DTWEXBGS", "DCOILBRENTEU", "NASDAQCOM"] as const;
export const YAHOO_SYMBOLS = ["SPY", "QQQ", "NVDA", "^VIX"] as const;
/** CLAUDE.md §2.2. */
export const APP_METRIC_IDS = [
  "hl.total_oi_usd", "hl.funding_skew", "hl.oi.BTC", "hl.oi.ETH", "hl.oi.SOL", "hl.oi.HYPE", "hl.funding.BTC", "hl.funding.ETH", "hl.funding.SOL", "hl.funding.HYPE",
  "fng.value", "cg.btc_dominance", "cg.total_mcap_usd", "llama.stablecoin_cap_usd", "deribit.btc_dvol", "fred.net_liquidity", "fred.spread_2s10s", "fred.VIXCLS",
  "fred.DGS10", "fred.DGS2", "fred.DTWEXBGS", "fred.DCOILWTICO", "elfa.mentions_24h_total",
];
const TOP_BY_OI = 25;
const TIMEOUT_MS = 20_000;
const DAY = 86_400_000;

export interface HlAsset {
  name: string;
  mark: number;
  chg24hPct: number;
  oiUsd: number;
  /** Hourly funding, as a fraction; annualised percent alongside for reading. */
  fundingHourly: number;
  fundingAnnPct: number;
  volUsd24h: number;
}

export interface Point {
  date: string;
  value: number;
}

export interface HlCyclesRead {
  asOf: string | null;
  stale: boolean;
  lastRefreshAgeH: number | null;
  regime: { state: string; since: string | null; allocation: number | null; momentum: number | null; conditionsOn: string[] } | null;
  levels: Array<{ key: string; label: string; value: number; distancePct: number | null; status: string | null }>;
  compass: { score: number | null; band: string | null; d7: number | null; d30: number | null; lenses: Array<{ key: string; score: number | null; band: string | null }> } | null;
  /** External text: goes to the model inside untrusted(). */
  brief: { sentences: string[]; confirm: string | null; invalidate: string | null } | null;
  flips: Array<{ date: string; from: string; to: string; price: number | null }>;
}

export interface ContextPack {
  asOf: string;
  hl: { assets: HlAsset[]; universeSize: number } | null;
  /** Mark per live HL symbol (gate + token checks); empty when HL failed. */
  marks: Record<string, number>;
  daily: Record<string, Candle[]>;
  weekly: Record<string, Candle[]>;
  /** Hourly candles since the oldest open setup's last check, per asset with an open setup. */
  path: Record<string, Candle[]>;
  hlCycles: HlCyclesRead | null;
  fred: Record<string, Point[]>;
  yahoo: Record<string, { price: number | null; closes: Point[] }>;
  fng: { value: number; label: string; series: Point[] } | null;
  stablecoins: { nowUsd: number; d7Pct: number | null; d30Pct: number | null; date: string } | null;
  app: { metrics: unknown[]; unusual: Array<{ id: string; latest: number; z30: number; mean30: number | null }>; sectors: unknown } | null;
  /** catalogue: the saved rule ids. */
  lab: { pulse: LabPulse | null; catalogue: string[] | null } | null;
  calendar: Array<{ kind: string; at: string }>;
  gaps: Gap[];
}

export interface CollectOptions {
  env: Record<string, string | undefined>;
  now: Date;
  fetch?: typeof fetch;
  /** Assets with an open setup, and since when their path is needed. */
  openPaths?: Array<{ asset: string; since: string }>;
  /** Hyperliquid client (default: shared/hl-client.ts with its weight guard); tests swap it. */
  hl?: HlClient;
}

export interface HlClient {
  metaAndCtxs: typeof fetchPerpMetaAndCtxs;
  candles: typeof fetchCandles;
}

class FetchError extends Error {
  constructor(
    readonly status: number | string,
    message: string,
  ) {
    super(message);
  }
}

const errStatus = (e: unknown): number | string => (e instanceof FetchError ? e.status : e instanceof Error && e.name === "TimeoutError" ? "timeout" : "error");
/**
 * A gap's detail is a short reason we wrote, never response text: it reaches the prompt, so an upstream body
 * (or a zod message quoting a received value) must not. Transport errors keep the runtime's own message.
 */
const errDetail = (e: unknown): string => {
  if (e instanceof FetchError) return e.message;
  if (e instanceof z.ZodError) return `unexpected response shape at ${[...new Set(e.issues.map((i) => i.path.join(".") || "(root)"))].slice(0, 5).join(", ")}`;
  if (e instanceof Error && e.name === "TimeoutError") return "timed out";
  return (e instanceof Error ? e.message : String(e)).replace(/[^\w .:/()-]/g, "").slice(0, 120);
};
const finite = (x: unknown): number | null => {
  const n = typeof x === "string" ? Number(x) : x;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const r = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;

async function fetchText(f: typeof fetch, url: string, init: RequestInit = {}): Promise<string> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new FetchError(res.status, `HTTP ${res.status}`);
  return text;
}
async function fetchJson(f: typeof fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  const text = await fetchText(f, url, init);
  try {
    return JSON.parse(text);
  } catch {
    throw new FetchError("bad-json", "response is not JSON");
  }
}

/** Runs one source; a throw becomes a gap and a null result. */
async function source<T>(gaps: Gap[], name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    gaps.push({ source: name, status: errStatus(e), detail: errDetail(e) });
    return null;
  }
}

/** Hyperliquid symbol shape (shared/schemas.ts CoinSchema): names reach the prompt, so anything else is dropped. */
export const SYMBOL = /^([A-Za-z0-9]+:)?[A-Za-z0-9]{1,24}$/;
const liveCtx = (c: AssetCtx) => !c.isDelisted && c.markPx > 0 && SYMBOL.test(c.name);

export function summariseHl(ctxs: AssetCtx[]): HlAsset[] {
  const live = ctxs.filter(liveCtx);
  const rows = live.map((c) => ({
    name: c.name,
    mark: c.markPx,
    chg24hPct: r(c.dayChange * 100),
    oiUsd: Math.round(c.openInterest * c.markPx),
    fundingHourly: c.funding,
    fundingAnnPct: r(c.funding * 24 * 365 * 100),
    volUsd24h: Math.round(c.dayNtlVlm),
  }));
  const majors = rows.filter((a) => (MAJORS as readonly string[]).includes(a.name));
  const top = rows.filter((a) => !majors.includes(a)).sort((a, b) => b.oiUsd - a.oiUsd).slice(0, TOP_BY_OI);
  return [...majors, ...top];
}

/** FRED fredgraph CSV → points; "." (no print) rows are skipped. */
export function parseFredCsv(csv: string): Point[] {
  const out: Point[] = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(",");
    const value = finite(raw);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && value !== null) out.push({ date, value });
  }
  return out;
}

async function fred(f: typeof fetch, id: string, now: Date): Promise<Point[]> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${day(now.getTime() - 45 * DAY)}`;
  let csv: string;
  try {
    csv = await fetchText(f, url);
  } catch (e) {
    if (e instanceof FetchError) throw e; // an HTTP answer: no transport retry
    // Transport error (FRED's HTTP/2 edge resets streams): one retry on a fresh, non-reused connection.
    csv = await fetchText(f, url, { headers: { connection: "close" } });
  }
  const points = parseFredCsv(csv);
  if (!points.length) throw new FetchError("empty", "no observations in the window");
  return points.slice(-30);
}

const YahooChart = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({ regularMarketPrice: z.number().nullable().optional() }).passthrough(),
          timestamp: z.array(z.number()).optional(),
          indicators: z.object({ quote: z.array(z.object({ close: z.array(z.number().nullable()).optional() }).passthrough()) }),
        }),
      )
      .min(1),
  }),
});

async function yahoo(f: typeof fetch, sym: string): Promise<{ price: number | null; closes: Point[] }> {
  const raw = await fetchJson(f, `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`, { headers: { "user-agent": "Mozilla/5.0" } });
  const res = YahooChart.parse(raw).chart.result[0]!;
  const ts = res.timestamp ?? [];
  const closes = res.indicators.quote[0]?.close ?? [];
  const points: Point[] = [];
  ts.forEach((t, i) => {
    const c = closes[i];
    if (typeof c === "number" && Number.isFinite(c)) points.push({ date: day(t * 1000), value: r(c) });
  });
  return { price: finite(res.meta.regularMarketPrice), closes: points };
}

const FngResponse = z.object({ data: z.array(z.object({ value: z.string(), value_classification: z.string().regex(/^[A-Za-z ]{1,24}$/), timestamp: z.string() })).min(1) });

const StableRow = z.object({ date: z.string(), totalCirculatingUSD: z.object({ peggedUSD: z.number() }).passthrough() }).passthrough();

export function stablecoinRead(rows: Array<{ date: string; totalCirculatingUSD: { peggedUSD: number } }>) {
  if (!rows.length) return null;
  const last = rows.at(-1)!;
  const back = (n: number) => rows[rows.length - 1 - n]?.totalCirculatingUSD.peggedUSD ?? null;
  const ch = (b: number | null) => (b ? r(((last.totalCirculatingUSD.peggedUSD - b) / b) * 100) : null);
  return { nowUsd: Math.round(last.totalCirculatingUSD.peggedUSD), d7Pct: ch(back(7)), d30Pct: ch(back(30)), date: day(Number(last.date) * 1000) };
}

const num = z.number().nullable().optional();
const HlcVector = z
  .object({
    asOf: num,
    stale: z.boolean().optional(),
    regime: z
      .object({
        // An identifier: it lands in the view file, the refresh reason and the brief header.
        state: z.string().regex(/^[a-z0-9_]{1,40}$/i),
        since: num,
        allocation: num,
        momentum: num,
        conditions: z.array(z.object({ key: z.string(), label: z.string().optional(), on: z.boolean() }).passthrough()).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    levels: z.array(z.object({ key: z.string(), label: z.string().optional(), value: z.number(), distancePct: num, status: z.string().nullable().optional() }).passthrough()).optional(),
    compass: z
      .object({
        headline: z.object({ score: num, band: z.string().nullable().optional(), d7: num, d30: num }).passthrough().optional(),
        lenses: z.array(z.object({ key: z.string().optional(), id: z.string().optional(), score: num, band: z.string().nullable().optional() }).passthrough()).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    brief: z.object({ sentences: z.array(z.string()).optional(), confirm: z.string().nullable().optional(), invalidate: z.string().nullable().optional() }).passthrough().nullable().optional(),
    flips: z.array(z.object({ t: z.number(), from: z.string(), to: z.string(), price: num }).passthrough()).optional(),
  })
  .passthrough();
const HlcHealth = z.object({ lastRefresh: num }).passthrough();

export function condenseHlCycles(vector: unknown, health: unknown, now: Date): HlCyclesRead {
  const v = HlcVector.parse(vector);
  const h = health === null ? null : HlcHealth.safeParse(health);
  const lastRefresh = h?.success ? (h.data.lastRefresh ?? null) : null;
  const ageH = lastRefresh === null ? null : r((now.getTime() - lastRefresh) / 3_600_000, 1);
  return {
    asOf: v.asOf ? day(v.asOf) : null,
    stale: v.stale === true || (ageH !== null && ageH > 2),
    lastRefreshAgeH: ageH,
    regime: v.regime
      ? {
          state: v.regime.state,
          since: v.regime.since ? day(v.regime.since) : null,
          allocation: v.regime.allocation ?? null,
          momentum: v.regime.momentum ?? null,
          conditionsOn: (v.regime.conditions ?? []).filter((c) => c.on).map((c) => c.key),
        }
      : null,
    levels: (v.levels ?? []).map((l) => ({ key: l.key, label: l.label ?? l.key, value: l.value, distancePct: l.distancePct ?? null, status: l.status ?? null })),
    compass: v.compass
      ? {
          score: v.compass.headline?.score ?? null,
          band: v.compass.headline?.band ?? null,
          d7: v.compass.headline?.d7 ?? null,
          d30: v.compass.headline?.d30 ?? null,
          lenses: (v.compass.lenses ?? []).map((l) => ({ key: l.key ?? l.id ?? "?", score: l.score ?? null, band: l.band ?? null })),
        }
      : null,
    brief: v.brief ? { sentences: (v.brief.sentences ?? []).slice(0, 8), confirm: v.brief.confirm ?? null, invalidate: v.brief.invalidate ?? null } : null,
    flips: (v.flips ?? [])
      .sort((a, b) => a.t - b.t)
      .slice(-3)
      .map((x) => ({ date: day(x.t), from: x.from, to: x.to, price: x.price ?? null })),
  };
}

const MetricSummaryRow = z.object({ seriesId: z.string(), latest: z.number().nullable(), mean30: z.number().nullable().optional(), z30: z.number().nullable().optional() }).passthrough();

export interface LabPulse {
  asOf: string;
  assets: Array<{ asset: string; lean: number; rules: Array<{ id: string; name: string; direction: string; firing: boolean; text: string }> }>;
}
const LabPulseSchema = z.object({
  asOf: z.string(),
  assets: z.array(
    z.object({ asset: z.string(), lean: z.number(), rules: z.array(z.object({ id: z.string(), name: z.string(), direction: z.string(), firing: z.boolean(), text: z.string() }).passthrough()) }).passthrough(),
  ),
});
const LabCatalogueSchema = z.object({ entries: z.array(z.object({ id: z.string() }).passthrough()) });

async function labTool(f: typeof fetch, base: string, token: string, name: string, args: unknown): Promise<unknown> {
  const body = (await fetchJson(f, `${base}/api/lab/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-lab-source": "cli" },
    body: JSON.stringify(args),
  })) as { ok?: boolean; result?: unknown; error?: string };
  if (body?.ok === false) throw new FetchError("tool-error", "lab tool returned ok: false");
  return body?.result;
}

/** The next FOMC, CPI and NFP release (intel/calendar.ts), soonest first. */
export function nextCatalysts(now: Date): Array<{ kind: string; at: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: string; at: string }> = [];
  for (const e of calendarEvents(now, now)) {
    const kind = e.key.split(":")[1]!;
    if (seen.has(kind) || !e.scheduledAt) continue;
    seen.add(kind);
    out.push({ kind, at: e.scheduledAt });
  }
  return out;
}

export async function collect(opts: CollectOptions): Promise<ContextPack> {
  const f = opts.fetch ?? fetch;
  const hlc: HlClient = opts.hl ?? { metaAndCtxs: fetchPerpMetaAndCtxs, candles: fetchCandles };
  const { now, env } = opts;
  const gaps: Gap[] = [];
  const nowMs = now.getTime();

  const hlP = source(gaps, "hyperliquid.metaAndAssetCtxs", () => hlc.metaAndCtxs(f));
  const candlesP = Promise.all(
    MAJORS.map(async (coin) => ({
      coin,
      daily: await source(gaps, `hyperliquid.candles.${coin}.1d`, () => hlc.candles(coin, "1d", nowMs - 400 * DAY, nowMs, f)),
      weekly: await source(gaps, `hyperliquid.candles.${coin}.1w`, () => hlc.candles(coin, "1w", nowMs - 3 * 365 * DAY, nowMs, f)),
    })),
  );
  const pathSince = new Map<string, number>();
  for (const p of opts.openPaths ?? []) {
    const t = Date.parse(p.since);
    if (Number.isFinite(t)) pathSince.set(p.asset, Math.min(pathSince.get(p.asset) ?? t, t));
  }
  const pathP = Promise.all(
    [...pathSince].map(async ([coin, since]) => ({
      coin,
      candles: await source(gaps, `hyperliquid.candles.${coin}.1h`, () => hlc.candles(coin, "1h", since - 3_600_000, nowMs, f)),
    })),
  );
  const hlcP = Promise.all([
    source(gaps, "hl-cycles.vector", () => fetchJson(f, "https://hl-cycles.vercel.app/api/vector.json")),
    source(gaps, "hl-cycles.health", () => fetchJson(f, "https://hl-cycles.vercel.app/api/health.json")),
  ]);
  const fredP = Promise.all(FRED_IDS.map(async (id) => ({ id, points: await source(gaps, `fred.${id}`, () => fred(f, id, now)) })));
  const yahooP = Promise.all(YAHOO_SYMBOLS.map(async (sym) => ({ sym, data: await source(gaps, `yahoo.${sym}`, () => yahoo(f, sym)) })));
  const fngP = source(gaps, "alternative.me.fng", async () => {
    const d = FngResponse.parse(await fetchJson(f, "https://api.alternative.me/fng/?limit=31")).data;
    return { value: Number(d[0]!.value), label: d[0]!.value_classification, series: d.map((x) => ({ date: day(Number(x.timestamp) * 1000), value: Number(x.value) })).reverse() };
  });
  const stableP = source(gaps, "defillama.stablecoins", async () => {
    const rows = z.array(StableRow).parse(await fetchJson(f, "https://stablecoins.llama.fi/stablecoincharts/all"));
    const read = stablecoinRead(rows);
    if (!read) throw new FetchError("empty", "no rows");
    return read;
  });

  const base = env.APP_URL?.trim().replace(/\/+$/, "");
  const token = env.LAB_API_TOKEN?.trim();
  const appP = (async (): Promise<ContextPack["app"]> => {
    if (!base || !token) return null;
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const [metrics, sectors] = await Promise.all([
      source(gaps, "app.metrics", async () => z.array(MetricSummaryRow).parse(await fetchJson(f, `${base}/api/metrics/summary?ids=${APP_METRIC_IDS.join(",")}`, auth))),
      source(gaps, "app.sectors", () => fetchJson(f, `${base}/api/sectors`, auth)),
    ]);
    if (!metrics && !sectors) return null;
    const unusual = (metrics ?? [])
      .filter((m) => m.latest !== null && typeof m.z30 === "number" && Math.abs(m.z30) >= 2)
      .map((m) => ({ id: m.seriesId, latest: m.latest!, z30: r(m.z30!), mean30: m.mean30 ?? null }));
    return { metrics: metrics ?? [], unusual, sectors };
  })();
  const labP = (async (): Promise<ContextPack["lab"]> => {
    if (!base || !token) return null;
    const [pulse, catalogue] = await Promise.all([
      source(gaps, "lab.market_pulse", async () => LabPulseSchema.parse(await labTool(f, base, token, "lab_market_pulse", {}))),
      source(gaps, "lab.catalogue_list", async () =>
        LabCatalogueSchema.parse(await labTool(f, base, token, "lab_catalogue_list", { live: false })).entries.map((e) => e.id)),
    ]);
    return { pulse, catalogue };
  })();

  const [hl, candles, paths, [vector, health], fredRows, yahooRows, fng, stablecoins, app, lab] = await Promise.all([hlP, candlesP, pathP, hlcP, fredP, yahooP, fngP, stableP, appP, labP]);

  if (!base || !token) gaps.push({ source: "app", status: "not-configured", detail: "APP_URL or LAB_API_TOKEN not set: no app baselines, sectors or Lab pulse" });
  let hlCycles: HlCyclesRead | null = null;
  if (vector !== null) {
    try {
      hlCycles = condenseHlCycles(vector, health, now);
      if (hlCycles.stale) gaps.push({ source: "hl-cycles", status: "stale", detail: `last refresh ${hlCycles.lastRefreshAgeH ?? "?"} h ago` });
    } catch (e) {
      gaps.push({ source: "hl-cycles.vector", status: "bad-shape", detail: errDetail(e) });
    }
  }

  const marks: Record<string, number> = {};
  for (const c of hl?.ctxs ?? []) if (liveCtx(c)) marks[c.name] = c.markPx;
  const pick = <T,>(rows: Array<{ k: string; v: T | null }>) => Object.fromEntries(rows.filter((x) => x.v !== null).map((x) => [x.k, x.v as T]));

  return {
    asOf: now.toISOString(),
    hl: hl ? { assets: summariseHl(hl.ctxs), universeSize: Object.keys(marks).length } : null,
    marks,
    daily: pick(candles.map((c) => ({ k: c.coin, v: c.daily }))),
    weekly: pick(candles.map((c) => ({ k: c.coin, v: c.weekly }))),
    path: pick(paths.map((p) => ({ k: p.coin, v: p.candles }))),
    hlCycles,
    fred: pick(fredRows.map((x) => ({ k: x.id, v: x.points }))),
    yahoo: pick(yahooRows.map((x) => ({ k: x.sym, v: x.data }))),
    fng,
    stablecoins,
    app,
    lab,
    calendar: nextCatalysts(now),
    gaps,
  };
}
