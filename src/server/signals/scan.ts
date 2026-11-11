import { ruleFiresAt } from "../lab/engine/evaluate.js";
import { featureLookback, parseFeatureId } from "../lab/engine/features.js";
import { isoDate } from "../lab/engine/util.js";
import type { LoadDatasetFn } from "../lab/service.js";
import { DAY_MS, type LabDataset } from "../lab/types.js";
import { mapLimit, msg } from "../lab/util.js";
import { DEFINITIONS, definitionRule, type SignalDefinition } from "./definitions.js";

// Live evaluation of the signal definitions (docs/RESEARCH.md "Signals v2" S2). The pure core asks one question per
// definition and coin: is the rule in zone on the last bar of the coin's dataset? It answers with the Lab engine's
// own live path (ruleFiresAt: makeCtx → zoneConditions → conditionSignal), the same in-zone path the event study
// replays (inZoneDays), so there is no second predicate. Evaluating live is not a trial and runs no study: nothing
// here touches the Lab store.

export interface DefinitionHit {
  definition: SignalDefinition;
  coin: string;
  /** The bar in zone, YYYY-MM-DD (the latest closed daily bar). */
  date: string;
  /** Feature values of the rule's conditions on that bar. */
  values: Record<string, number | null>;
}

/** Metric ids the definitions' conditions read (the regime reads the price). */
export function definitionMetrics(defs: readonly SignalDefinition[] = DEFINITIONS): string[] {
  return [...new Set(defs.flatMap((d) => d.rule.conditions.map((c) => parseFeatureId(c.feature).metric)))];
}

/**
 * Is the definition in zone on the dataset's last bar? null when the dataset lacks one of its metrics (e.g. no
 * collected OI for the coin): not evaluable, which is not "out of zone".
 */
export function inZoneNow(def: SignalDefinition, data: LabDataset): { inZone: boolean; date: string; values: Record<string, number | null> } | null {
  if (!data.t.length || definitionMetrics([def]).some((m) => !data.metrics[m])) return null;
  const r = ruleFiresAt(definitionRule(def, data.asset), data);
  return { inZone: r.firing, date: r.latest.date, values: r.latest.values };
}

/** Every definition in zone on the dataset's last bar. */
export function scanDataset(data: LabDataset, defs: readonly SignalDefinition[] = DEFINITIONS): DefinitionHit[] {
  return defs.flatMap((definition) => {
    const z = inZoneNow(definition, data);
    return z?.inZone ? [{ definition, coin: data.asset, date: z.date, values: z.values }] : [];
  });
}

// ---------------------------------------------------------------- service

/** One item a scan left out, and why. */
export interface ScanDrop {
  coin: string;
  /** The definition left unevaluated on the coin; null when the whole coin was dropped. */
  definition: string | null;
  reason: string;
  /** Whether a later scan may evaluate it: false only for a coin Hyperliquid does not list, or a metric with no data at all for the coin (OKX does not list it). */
  retry: boolean;
}

export interface DefinitionScan {
  /** The closed daily bar evaluated (YYYY-MM-DD): yesterday (UTC) at scan time. */
  bar: string;
  /** Coins scanned (their data loaded and current). */
  coins: number;
  /**
   * Dropped items: a coin whose data failed, came too late or whose price does not reach `bar` (one each), plus each
   * coin × definition left unevaluated because a metric its conditions read has no raw value on `bar`.
   */
  dropped: number;
  /** The dropped items with their reasons (`dropped` = its length). */
  drops: ScanDrop[];
  hits: DefinitionHit[];
}

export interface DefinitionScannerDeps {
  /** The Lab service's dataset loader (the registry's, with its cache). */
  loadDataset: LoadDatasetFn;
  /** Coins to scan: the Lab's default universe plus the watchlist. */
  coins: () => Promise<string[]>;
  /**
   * Coins Hyperliquid lists now (its perp universe). A scanned coin not in it is dropped for the day without a load
   * (Hyperliquid answers an unknown coin with a 500, which reads like an outage). Omitted, or failing: every coin is
   * loaded.
   */
  listed?: () => Promise<ReadonlySet<string>>;
  now: () => number;
  definitions?: readonly SignalDefinition[];
  /**
   * Coins not loaded within this many ms of the scan's start are dropped. Default SCAN_DEADLINE_MS; Infinity for
   * none (a scan in the background or from the command line).
   */
  deadlineMs?: number;
}

/** Days of price history a live scan loads: the regime's 50-day mean, its 3-day persistence and warm-up. */
export const SCAN_LOOKBACK_DAYS = 200;
/** Extra days loaded before a metric's own lookback: the registry forward-fills a gap of up to 3 days. */
export const SCAN_FILL_MARGIN_DAYS = 7;
export const SCAN_DEADLINE_MS = 120_000;
/** A scan that dropped anything is kept this long, not for the whole UTC day: data may still be arriving. */
export const SCAN_RETRY_MS = 15 * 60_000;
const SCAN_CONCURRENCY = 4;

/**
 * Days of each metric a scan loads (before the bar, the bar included): the most any of the definitions' features on it
 * reads (featureLookback) plus SCAN_FILL_MARGIN_DAYS. The last bar then reads exactly what the full history gives it
 * (the window test in scan.test.ts), and the slow fetches (Hyperliquid funding) stay short.
 */
export function metricLookbackDays(defs: readonly SignalDefinition[] = DEFINITIONS): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of defs.flatMap((d) => d.rule.conditions)) {
    const spec = parseFeatureId(c.feature);
    out[spec.metric] = Math.max(out[spec.metric] ?? 0, featureLookback(spec) + SCAN_FILL_MARGIN_DAYS);
  }
  return out;
}

/**
 * Definitions whose every metric has a raw (not forward-filled) value on `bar`, and the rest with the reason. The
 * registry forward-fills funding and OI for up to 3 days, so without this a rule could read a carried-forward value and
 * still be labelled `bar`. A loader that reports no `lastRaw` leaves every definition out (fail closed). A day of
 * funding still settling has no raw value: the ht provider leaves out a last day without its 23:00 UTC settlement,
 * so lastRaw ends the day before and the definition is dropped (and retried), never read on a partial sum. A metric
 * in `noData` (fetched, nothing in range: e.g. a coin OKX does not list) is dropped without a retry.
 */
export function evaluableDefinitions(defs: readonly SignalDefinition[], lastRaw: Record<string, string> | undefined, bar: string, noData: readonly string[] = []) {
  const ok: SignalDefinition[] = [];
  const left: Array<{ definition: SignalDefinition; reason: string; retry: boolean }> = [];
  for (const d of defs) {
    const ms = definitionMetrics([d]);
    const none = ms.filter((m) => noData.includes(m));
    const stale = ms.filter((m) => (lastRaw?.[m] ?? "") < bar);
    if (none.length) left.push({ definition: d, reason: `no ${none.join(", ")} data for the coin`, retry: false });
    else if (stale.length) left.push({ definition: d, reason: stale.map((m) => `${m} ${lastRaw?.[m] ? `last complete day ${lastRaw[m]}` : "not loaded"}, not ${bar}`).join("; "), retry: true });
    else ok.push(d);
  }
  return { ok, left };
}

/**
 * Scans every definition over `coins()`, at most once per closed daily bar: a complete scan of a UTC day is shared by
 * every caller (in flight or done) until the day turns; one that dropped anything a later scan may evaluate is kept
 * only SCAN_RETRY_MS after it finished (the first scan after midnight may run before stored data reaches the bar);
 * drops a retry cannot change (a coin Hyperliquid does not list, a metric with no data at all for the coin) keep the
 * scan for the day; a scan that fails as a whole (no coin list) is forgotten so the next call retries. Scans never
 * overlap: one still running when the day turns finishes before the new day's starts. A coin whose data fails, arrives after the deadline or
 * does not reach the closed bar is dropped and counted, never fatal; so is a coin × definition whose metrics have no
 * raw value on it. `latest()` is the last scan that finished, without waiting for one in flight: a caller that cannot
 * wait (the board without a database, where the first scan takes minutes) kicks `scan()` and serves `latest()`.
 */
export function createDefinitionScanner(deps: DefinitionScannerDeps) {
  const defs = deps.definitions ?? DEFINITIONS;
  const metrics = definitionMetrics(defs);
  const lookback = metricLookbackDays(defs);
  const deadlineMs = deps.deadlineMs ?? SCAN_DEADLINE_MS;
  let memo: { day: string; p: Promise<DefinitionScan>; until?: number } | null = null;
  let last: DefinitionScan | null = null;

  async function run(started: number): Promise<DefinitionScan> {
    const bar = isoDate(Math.floor(started / DAY_MS) * DAY_MS - DAY_MS);
    const barMs = Math.floor(started / DAY_MS) * DAY_MS - DAY_MS;
    const from = isoDate(barMs - (SCAN_LOOKBACK_DAYS - 1) * DAY_MS);
    const metricFrom = Object.fromEntries(Object.entries(lookback).map(([m, days]) => [m, isoDate(barMs - (days - 1) * DAY_MS)]));
    const all = await deps.coins();
    const unique = all.filter((c, i) => all.findIndex((x) => x.toUpperCase() === c.toUpperCase()) === i);
    const listed = deps.listed
      ? await deps.listed().then((s) => new Set([...s].map((c) => c.toUpperCase())), (err) => (console.warn(`[signals] listed coins unavailable (${msg(err)}); loading every coin`), null))
      : null;
    const drops: ScanDrop[] = [];
    const coins = unique.filter((coin) => {
      if (!listed || listed.has(coin.toUpperCase())) return true;
      drops.push({ coin, definition: null, reason: "not listed on Hyperliquid", retry: false });
      return false;
    });
    const loaded = await mapLimit(coins, SCAN_CONCURRENCY, async (coin) => {
      const left = deadlineMs - (deps.now() - started);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (left <= 0) throw new Error("not loaded before the deadline");
        const load = deps.loadDataset({ asset: coin, metrics, price: "ht:price", from, metricFrom, deadline: true });
        // No timer without a deadline: setTimeout(Infinity) is clamped to 1 ms.
        const r = Number.isFinite(left) ? await Promise.race([load, new Promise<null>((res) => (timer = setTimeout(() => res(null), left)))]) : await load;
        if (!r) throw new Error("not loaded before the deadline");
        if (isoDate(r.dataset.t.at(-1) ?? 0) !== bar) throw new Error(`data ends before ${bar}`);
        return r;
      } catch (err) {
        drops.push({ coin, definition: null, reason: msg(err), retry: true });
        console.warn(`[signals] ${coin} dropped from the definition scan: ${msg(err)}`);
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
    const hits: DefinitionHit[] = [];
    let scanned = 0;
    for (const r of loaded) {
      if (!r) continue;
      const d = r.dataset;
      try {
        const { ok, left } = evaluableDefinitions(defs, r.lastRaw, bar, r.noData);
        if (left.length) console.warn(`[signals] ${d.asset}: ${left.length} definition(s) dropped (${left.map((l) => `${l.definition.id}: ${l.reason}`).join(" | ")})`);
        hits.push(...scanDataset(d, ok));
        drops.push(...left.map((l) => ({ coin: d.asset, definition: l.definition.id, reason: l.reason, retry: l.retry })));
        scanned++;
      } catch (err) {
        drops.push({ coin: d.asset, definition: null, reason: msg(err), retry: true });
        console.warn(`[signals] ${d.asset} dropped from the definition scan: ${msg(err)}`);
      }
    }
    return { bar, coins: scanned, dropped: drops.length, drops, hits };
  }

  return {
    scan(): Promise<DefinitionScan> {
      const now = deps.now();
      const day = isoDate(now);
      if (memo?.day === day && !(memo.until !== undefined && now >= memo.until)) return memo.p;
      // One scan at a time: a scan still running when the day turns (or past a retry) finishes before the next starts,
      // whose clock (bar, deadline) starts when it does.
      const prev = memo?.p;
      const m: NonNullable<typeof memo> = { day, p: prev ? prev.then(() => {}, () => {}).then(() => run(deps.now())) : run(now) };
      memo = m;
      // An incomplete scan expires SCAN_RETRY_MS after it finished (not after it started: a scan longer than that would
      // be stale on arrival); a failed one clears only its own memo, never a newer one.
      m.p.then(
        (r) => {
          if (r.drops.some((x) => x.retry)) m.until = deps.now() + SCAN_RETRY_MS;
          if (!last || r.bar >= last.bar) last = r;
        },
        () => {
          if (memo === m) memo = null;
        },
      );
      return m.p;
    },
    /** The last scan that finished (of any bar), or null before the first one has. */
    latest(): DefinitionScan | null {
      return last;
    },
  };
}
export type DefinitionScanner = ReturnType<typeof createDefinitionScanner>;
