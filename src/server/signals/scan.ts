import { ruleFiresAt } from "../lab/engine/evaluate.js";
import { parseFeatureId } from "../lab/engine/features.js";
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
  hits: DefinitionHit[];
}

export interface DefinitionScannerDeps {
  /** The Lab service's dataset loader (the registry's, with its cache). */
  loadDataset: LoadDatasetFn;
  /** Coins to scan: the Lab's default universe plus the watchlist. */
  coins: () => Promise<string[]>;
  now: () => number;
  definitions?: readonly SignalDefinition[];
  /** Coins not loaded within this many ms of the scan's start are dropped. Default SCAN_DEADLINE_MS. */
  deadlineMs?: number;
}

/** Days of history a live scan loads: the longest window (90) plus the regime's 50-day mean and warm-up. */
export const SCAN_LOOKBACK_DAYS = 200;
export const SCAN_DEADLINE_MS = 120_000;
/** A scan that dropped anything is kept this long, not for the whole UTC day: data may still be arriving. */
export const SCAN_RETRY_MS = 15 * 60_000;
const SCAN_CONCURRENCY = 4;

/**
 * Definitions whose every metric has a raw (not forward-filled) value on `bar`, and the number left out. The registry
 * forward-fills funding and OI for up to 3 days, so without this a rule could read a carried-forward value and still
 * be labelled `bar`. A loader that reports no `lastRaw` leaves every definition out (fail closed). Not detectable
 * here: a partial day of funding. The daily funding value is the sum of the day's stored hourly settlements, and the
 * loader returns only that sum, so a day whose last settlements are not yet stored looks complete.
 */
export function evaluableDefinitions(defs: readonly SignalDefinition[], lastRaw: Record<string, string> | undefined, bar: string) {
  const ok = defs.filter((d) => definitionMetrics([d]).every((m) => (lastRaw?.[m] ?? "") >= bar));
  return { ok, left: defs.length - ok.length };
}

/**
 * Scans every definition over `coins()`, at most once per closed daily bar: a complete scan of a UTC day is shared by
 * every caller (in flight or done) until the day turns; one that dropped anything is kept only SCAN_RETRY_MS (the
 * first scan after midnight may run before stored data reaches the bar); a scan that fails as a whole (no coin list)
 * is forgotten so the next call retries. A coin whose data fails, arrives after the deadline or does not reach the
 * closed bar is dropped and counted, never fatal; so is a coin × definition whose metrics have no raw value on it.
 */
export function createDefinitionScanner(deps: DefinitionScannerDeps) {
  const defs = deps.definitions ?? DEFINITIONS;
  const metrics = definitionMetrics(defs);
  const deadlineMs = deps.deadlineMs ?? SCAN_DEADLINE_MS;
  let memo: { day: string; p: Promise<DefinitionScan>; until?: number } | null = null;

  async function run(started: number): Promise<DefinitionScan> {
    const bar = isoDate(Math.floor(started / DAY_MS) * DAY_MS - DAY_MS);
    const from = isoDate(started - SCAN_LOOKBACK_DAYS * DAY_MS);
    const all = await deps.coins();
    const coins = all.filter((c, i) => all.findIndex((x) => x.toUpperCase() === c.toUpperCase()) === i);
    let dropped = 0;
    const loaded = await mapLimit(coins, SCAN_CONCURRENCY, async (coin) => {
      const left = deadlineMs - (deps.now() - started);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (left <= 0) throw new Error("not loaded before the deadline");
        const late = new Promise<null>((res) => (timer = setTimeout(() => res(null), left)));
        const r = await Promise.race([deps.loadDataset({ asset: coin, metrics, price: "ht:price", from, deadline: true }), late]);
        if (!r) throw new Error("not loaded before the deadline");
        if (isoDate(r.dataset.t.at(-1) ?? 0) !== bar) throw new Error(`data ends before ${bar}`);
        return r;
      } catch (err) {
        dropped++;
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
        const { ok, left } = evaluableDefinitions(defs, r.lastRaw, bar);
        if (left) console.warn(`[signals] ${d.asset}: ${left} definition(s) dropped, a metric has no raw value on ${bar}`);
        hits.push(...scanDataset(d, ok));
        dropped += left;
        scanned++;
      } catch (err) {
        dropped++;
        console.warn(`[signals] ${d.asset} dropped from the definition scan: ${msg(err)}`);
      }
    }
    return { bar, coins: scanned, dropped, hits };
  }

  return {
    scan(): Promise<DefinitionScan> {
      const now = deps.now();
      const day = isoDate(now);
      if (memo?.day === day && !(memo.until !== undefined && now >= memo.until)) return memo.p;
      const m: NonNullable<typeof memo> = { day, p: run(now) };
      memo = m;
      // An incomplete scan expires SCAN_RETRY_MS after it started; a failed one clears only its own memo, never a newer one.
      m.p.then(
        (r) => {
          if (r.dropped > 0) m.until = now + SCAN_RETRY_MS;
        },
        () => {
          if (memo === m) memo = null;
        },
      );
      return m.p;
    },
  };
}
export type DefinitionScanner = ReturnType<typeof createDefinitionScanner>;
