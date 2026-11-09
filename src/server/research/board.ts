import type { NoveltyEntry, Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import {
  boardStudy, ResearchSignalSchema,
  type BoardResponse, type ResearchSignal, type ResearchSource, type SourceStatus, type UnavailableReason,
} from "../../shared/research.js";
import type { CatalogueEntry, MarketPulse } from "../lab/types.js";
import { firingEntries, noveltySignal, opportunitySignal, radarSignal, ruleSignal } from "./signals.js";
import { studyKey, type StudyCache } from "./study.js";

// Research board (docs/RESEARCH.md B2): each source loads on its own, under its own timeout; a source that throws,
// times out or is not available here (no worker loop, no database) is listed `unavailable` with a fixed reason (the
// error itself goes to the server log) and the board still answers with the rest. Inside a source each item is mapped
// and validated on its own: a bad item is dropped and counted, never a failed board.

const DAY = 86_400_000;
/** Novelty bars shown: the detector's retry window (closed days). */
export const NOVELTY_DAYS = 3;
/** Radar calls shown: those inside the kill-watch window and not killed. */
export const RADAR_DAYS = 7;
export const OPPORTUNITY_LIMIT = 50;
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
  /** Landed radar calls; throw SourceUnavailable when data/radar is absent. */
  radarCalls: () => Promise<RadarCall[]>;
  cache: StudyCache;
  timeoutMs?: number;
}

/**
 * The board as a guest sees it (PUBLIC_MODE without a session): /radar is not guest-readable, so the radar source
 * is `unavailable` ("sign in required") and contributes no calls, instead of leaking them through the board.
 */
export function boardDepsFor<D extends Pick<BoardDeps, "radarCalls">>(deps: D, guest: boolean): D {
  return guest ? { ...deps, radarCalls: async () => { throw new SourceUnavailable("sign in required"); } } : deps;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new TimedOut()), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Defined in the shared contract so the UI POSTs exactly the body the board's cache is keyed on. */
export { boardStudy };

/** Today's cached study of the signal's rule in its scope, if any. */
export const evidenceFor = (cache: StudyCache, s: Pick<ResearchSignal, "rule" | "coin" | "scope">, now: number) => {
  const q = boardStudy(s);
  return q ? (cache.get(studyKey(q, now))?.summary ?? null) : null;
};

/** Maps and validates each item on its own; an item that throws or fails the schema is dropped (and logged). */
function mapEach<T>(source: ResearchSource, items: T[], map: (t: T) => Omit<ResearchSignal, "evidence">): { signals: ResearchSignal[]; dropped: number } {
  const signals: ResearchSignal[] = [];
  let dropped = 0;
  for (const item of items) {
    try {
      const r = ResearchSignalSchema.safeParse({ ...map(item), evidence: null });
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
  const bar = (t: number) => new Date(t).toISOString().slice(0, 10);
  let pulse: BoardResponse["pulse"] = null;
  let rulePulse: BoardResponse["pulse"] = null;

  const loaders: Record<ResearchSource, () => Promise<{ signals: ResearchSignal[]; dropped: number }>> = {
    rule: async () => {
      const r = await deps.pulse();
      rulePulse = { assets: r.pulse.assets.length, firing: r.pulse.assets.reduce((n, a) => n + a.rules.filter((x) => x.firing).length, 0) };
      const at = Date.parse(r.pulse.asOf);
      return mapEach("rule", firingEntries(r.pulse, r.catalogue), (e) => ruleSignal(e, at));
    },
    novelty: async () => mapEach("novelty", await deps.novelty(bar(now - NOVELTY_DAYS * DAY)), noveltySignal),
    opportunity: async () => mapEach("opportunity", await deps.opportunities(OPPORTUNITY_LIMIT), opportunitySignal),
    radar: async () => mapEach("radar", (await deps.radarCalls()).filter((c) => !c.killed_at && c.date >= bar(now - RADAR_DAYS * DAY)), radarSignal),
  };

  const sources = {} as Record<ResearchSource, SourceStatus>;
  const signals: ResearchSignal[] = [];
  await Promise.all(
    (Object.keys(loaders) as ResearchSource[]).map(async (source) => {
      try {
        const got = await withTimeout(loaders[source](), ms);
        sources[source] = { state: "ok", count: got.signals.length, dropped: got.dropped };
        if (source === "rule") pulse = rulePulse; // only from a load that made it in time
        for (const s of got.signals) signals.push({ ...s, evidence: evidenceFor(deps.cache, s, now) });
      } catch (e) {
        const reason: UnavailableReason = e instanceof SourceUnavailable ? e.reason : e instanceof TimedOut ? "timed out" : "source failed (see server log)";
        if (!(e instanceof SourceUnavailable)) console.error(`[research] ${source}:`, e instanceof TimedOut ? `no answer within ${ms} ms` : e);
        sources[source] = { state: "unavailable", reason, count: 0, dropped: 0 };
      }
    }),
  );
  signals.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { asOf: new Date(now).toISOString(), signals, sources: { novelty: sources.novelty, rule: sources.rule, opportunity: sources.opportunity, radar: sources.radar }, pulse };
}
