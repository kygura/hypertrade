import type { LedgerStats, NoveltyEntry, Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import {
  boardStudy, ResearchSignalSchema, studyEvidence,
  type BoardResponse, type RadarScoreRow, type ResearchSignal, type ResearchSource, type SourceStatus, type UnavailableReason,
} from "../../shared/research.js";
import { isoDate } from "../lab/engine/util.js";
import type { CatalogueEntry, MarketPulse } from "../lab/types.js";
import type { DefinitionScan } from "../signals/scan.js";
import { FEATURE_MIN_TICKS_24H } from "../platform/features.js";
import { definitionSignal, firingEntries, noveltySignal, opportunitySignal, radarSignal, ruleSignal } from "./signals.js";
import { bounded, STUDY_STORE_TIMEOUT_MS, studyKey, type StudyCache } from "./study.js";

// Research board (docs/RESEARCH.md B2, Signals v2 S3): each source loads on its own, under its own timeout; a source
// that throws, times out or is not available here (no worker loop, no database) is listed `unavailable` with a fixed
// reason (the error itself goes to the server log) and the board still answers with the rest. Inside a source each
// item is mapped and validated on its own: a bad item is dropped and counted, never a failed board.

const DAY = 86_400_000;
/** Novelty bars shown: the detector's retry window (closed days). */
const NOVELTY_DAYS = 3;
/** Radar calls shown: those inside the kill-watch window and not killed. */
const RADAR_DAYS = 7;
const OPPORTUNITY_LIMIT = 50;
export const SOURCE_TIMEOUT_MS = 20_000;

/** Thrown by a loader for a source that cannot exist here, with the fixed reason shown. */
export class SourceUnavailable extends Error {
  readonly reason: UnavailableReason;
  constructor(reason: UnavailableReason) {
    super(reason);
    this.reason = reason;
  }
}
class TimedOut extends Error {}

export interface BoardDeps {
  now: () => number;
  /** Market Pulse and the catalogue it covers (Lab service). */
  pulse: () => Promise<{ pulse: MarketPulse; catalogue: CatalogueEntry[] }>;
  /** Novelty journal from bar `sinceBar` on; throw SourceUnavailable without the novelty loop's inputs. */
  novelty: (sinceBar: string) => Promise<NoveltyEntry[]>;
  /** Pre-decision platform opportunities; throw SourceUnavailable without a platform context. */
  opportunities: (limit: number) => Promise<Opportunity[]>;
  /**
   * The ledger record (platform/stats.ts setupLedgerStats) of each setup kind asked, read after the opportunities for
   * the kinds on the board; a failure or no answer within `ledgerTimeoutMs` leaves their evidence null.
   */
  ledger: (setupKinds: string[]) => Promise<LedgerStats[]>;
  /**
   * Scanner ticks persisted in the last 24 h (distinct scan_snapshots timestamps); null when unknown. Read with the
   * opportunities under `ledgerTimeoutMs`; under FEATURE_MIN_TICKS_24H the source carries a note (scannerNote).
   */
  scannerTicks24h?: () => Promise<number | null>;
  /** Landed radar calls and the scorecard over all of them; throw SourceUnavailable when data/radar is absent. */
  radar: () => Promise<{ calls: RadarCall[]; scorecard: RadarScoreRow[] }>;
  /** Signal definitions in zone on the latest closed bar (signals/scan.ts); throw SourceUnavailable where no scan can run. */
  definitions: () => Promise<DefinitionScan>;
  cache: StudyCache;
  timeoutMs?: number;
  /** Longest the ledger read may take before opportunities go out with `evidence: null`. Default STUDY_STORE_TIMEOUT_MS. */
  ledgerTimeoutMs?: number;
}

/**
 * The board as a guest sees it (PUBLIC_MODE without a session): /radar is not guest-readable, so the radar source
 * is `unavailable` ("sign in required") and contributes no calls, instead of leaking them through the board.
 */
export function boardDepsFor<D extends Pick<BoardDeps, "radar">>(deps: D, guest: boolean): D {
  return guest ? { ...deps, radar: async () => { throw new SourceUnavailable("sign in required"); } } : deps;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new TimedOut()), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Defined in the shared contract so the UI POSTs exactly the body the board's cache is keyed on. */
export { boardStudy };

/** Today's cached study of the signal's rule in its scope, if any. */
const evidenceFor = (cache: StudyCache, s: Pick<ResearchSignal, "rule" | "coin" | "scope">, now: number) => {
  const q = boardStudy(s);
  return q ? (cache.get(studyKey(q, now))?.summary ?? null) : null;
};

/**
 * Attaches today's cached study of the signal's rule: as `study` evidence for the sources it backs (rule, novelty,
 * definition), as `dailyStudy` for an opportunity, whose evidence stays its ledger record.
 */
function attachStudy(cache: StudyCache, s: ResearchSignal, now: number): void {
  const summary = evidenceFor(cache, s, now);
  if (s.source === "opportunity") s.dailyStudy = summary;
  else if (s.rule) s.evidence = summary && studyEvidence(summary);
}

/**
 * The opportunity source's note when the scanner cannot compute its features: the z features need a ring point
 * every 15 min (FEATURE_MIN_TICKS_24H a day), which only the always-on server's 1-minute scan gives; a scanner run
 * from a cron leaves them null and no setup can fire. null when the cadence is enough or unknown. The count and the
 * need are stated; the claim that nothing can fire only well under the need (under half: the 24 h funding features
 * need 48 points), never near it, where one missed run would not stop the features.
 */
export function scannerNote(ticks24h: number | null): string | null {
  if (ticks24h == null || ticks24h >= FEATURE_MIN_TICKS_24H) return null;
  const base = `scanner has ${ticks24h} tick${ticks24h === 1 ? "" : "s"} stored in the last 24 h; the setup features need one per 15 min (${FEATURE_MIN_TICKS_24H} a day; the always-on server scans every minute)`;
  return ticks24h < FEATURE_MIN_TICKS_24H / 2 ? `${base}: too few for any setup to fire` : base;
}

/** Maps and validates each item on its own; an item that throws or fails the schema is dropped (and logged). */
function mapEach<T>(source: ResearchSource, items: T[], map: (t: T) => Omit<ResearchSignal, "dailyStudy">): { signals: ResearchSignal[]; dropped: number; note?: string } {
  const signals: ResearchSignal[] = [];
  let dropped = 0;
  for (const item of items) {
    try {
      const r = ResearchSignalSchema.safeParse({ ...map(item), dailyStudy: null });
      if (r.success) signals.push(r.data);
      else {
        dropped++;
        console.error(`[research] ${source}: dropped an item: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      }
    } catch (e) {
      dropped++;
      console.error(`[research] ${source}: dropped an item:`, e);
    }
  }
  return { signals, dropped };
}

export async function buildBoard(deps: BoardDeps): Promise<BoardResponse> {
  const now = deps.now();
  const ms = deps.timeoutMs ?? SOURCE_TIMEOUT_MS;
  let pulse: BoardResponse["pulse"] = null;
  let rulePulse: BoardResponse["pulse"] = null;

  const loaders: Record<ResearchSource, () => Promise<{ signals: ResearchSignal[]; dropped: number; note?: string }>> = {
    rule: async () => {
      const r = await deps.pulse();
      rulePulse = { assets: r.pulse.assets.length, firing: r.pulse.assets.reduce((n, a) => n + a.rules.filter((x) => x.firing).length, 0) };
      const at = Date.parse(r.pulse.asOf);
      return mapEach("rule", firingEntries(r.pulse, r.catalogue), (e) => ruleSignal(e, at));
    },
    novelty: async () => mapEach("novelty", await deps.novelty(isoDate(now - NOVELTY_DAYS * DAY)), noveltySignal),
    opportunity: async () => {
      const opps = await deps.opportunities(OPPORTUNITY_LIMIT);
      const kinds = [...new Set(opps.map((o) => o.setupKind))];
      const storeMs = deps.ledgerTimeoutMs ?? STUDY_STORE_TIMEOUT_MS;
      const [ledger, ticks] = await Promise.all([
        opps.length ? bounded(Promise.resolve().then(() => deps.ledger(kinds)), null, storeMs, "opportunity ledger") : [],
        deps.scannerTicks24h ? bounded(Promise.resolve().then(() => deps.scannerTicks24h!()), null, storeMs, "scanner ticks") : null,
      ]);
      const note = scannerNote(ticks);
      return { ...mapEach("opportunity", opps, (o) => opportunitySignal(o, ledger)), ...(note && { note }) };
    },
    radar: async () => {
      const r = await deps.radar();
      return mapEach("radar", r.calls.filter((c) => !c.killed_at && c.date >= isoDate(now - RADAR_DAYS * DAY)), (c) => radarSignal(c, r.scorecard));
    },
    // Coins the scan dropped (data failed or late) count as dropped items of the source.
    definition: async () => {
      const scan = await deps.definitions();
      const got = mapEach("definition", scan.hits, definitionSignal);
      return { signals: got.signals, dropped: got.dropped + scan.dropped };
    },
  };

  const sources = {} as Record<ResearchSource, SourceStatus>;
  const signals: ResearchSignal[] = [];
  await Promise.all(
    (Object.keys(loaders) as ResearchSource[]).map(async (source) => {
      try {
        const got = await withTimeout(loaders[source](), ms);
        sources[source] = { state: "ok", count: got.signals.length, dropped: got.dropped, ...(got.note && { note: got.note }) };
        if (source === "rule") pulse = rulePulse; // only from a load that made it in time
        signals.push(...got.signals);
      } catch (e) {
        const reason: UnavailableReason = e instanceof SourceUnavailable ? e.reason : e instanceof TimedOut ? "timed out" : "source failed (see server log)";
        if (!(e instanceof SourceUnavailable)) console.error(`[research] ${source}:`, e instanceof TimedOut ? `no answer within ${ms} ms` : e);
        sources[source] = { state: "unavailable", reason, count: 0, dropped: 0 };
      }
    }),
  );
  // Evidence: one store read for every signal's study not already in memory (never one per signal), bounded by the
  // cache's short store timeout (STUDY_STORE_TIMEOUT_MS), so a stalled store adds at most that to the build; a slow
  // or failed read leaves the board with what memory has.
  const keys = signals.flatMap((s) => {
    const q = boardStudy(s);
    return q ? [studyKey(q, now)] : [];
  });
  await deps.cache.load(keys);
  for (const s of signals) attachStudy(deps.cache, s, now);
  signals.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  const { novelty, rule, opportunity, radar, definition } = sources;
  return { asOf: new Date(now).toISOString(), signals, sources: { novelty, rule, opportunity, radar, definition }, pulse };
}
