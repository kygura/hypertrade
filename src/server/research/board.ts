import type { NoveltyEntry, Opportunity } from "../../shared/platform.js";
import type { RadarCall } from "../../shared/radar.js";
import { STUDY_DEFAULTS, type BoardResponse, type ResearchSignal, type ResearchSource, type SourceStatus } from "../../shared/research.js";
import type { CatalogueEntry, MarketPulse } from "../lab/types.js";
import { noveltySignal, opportunitySignal, radarSignal, ruleSignals } from "./signals.js";
import type { StudyCache } from "./study.js";

// Research board (docs/RESEARCH.md B2): each source loads on its own, under its own timeout; a source that throws,
// times out or is not available here (no worker loop, no database) is listed `unavailable` with the reason and the
// board still answers with the rest.

const DAY = 86_400_000;
/** Novelty bars shown: the detector's retry window (closed days). */
export const NOVELTY_DAYS = 3;
/** Radar calls shown: those inside the kill-watch window and not killed. */
export const RADAR_DAYS = 7;
export const OPPORTUNITY_LIMIT = 50;
export const SOURCE_TIMEOUT_MS = 20_000;

/** Thrown by a loader for a source that cannot exist here: its message is the reason shown. */
export class SourceUnavailable extends Error {}

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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`no answer within ${ms / 1000} s`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Today's cached study of the signal's rule on its coin with the board's default exits, if any. */
export const evidenceFor = (cache: StudyCache, s: Pick<ResearchSignal, "rule" | "coin">) =>
  s.rule ? (cache.get({ rule: s.rule, coin: s.coin, ...STUDY_DEFAULTS })?.summary ?? null) : null;

export async function buildBoard(deps: BoardDeps): Promise<BoardResponse> {
  const now = deps.now();
  const ms = deps.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const bar = (t: number) => new Date(t).toISOString().slice(0, 10);
  let pulse: BoardResponse["pulse"] = null;
  let rulePulse: BoardResponse["pulse"] = null;

  const loaders: Record<ResearchSource, () => Promise<Omit<ResearchSignal, "evidence">[]>> = {
    rule: async () => {
      const r = await deps.pulse();
      rulePulse = { assets: r.pulse.assets.length, firing: r.pulse.assets.reduce((n, a) => n + a.rules.filter((x) => x.firing).length, 0) };
      return ruleSignals(r.pulse, r.catalogue);
    },
    novelty: async () => (await deps.novelty(bar(now - NOVELTY_DAYS * DAY))).map(noveltySignal),
    opportunity: async () => (await deps.opportunities(OPPORTUNITY_LIMIT)).map(opportunitySignal),
    radar: async () => (await deps.radarCalls()).filter((c) => !c.killed_at && c.date >= bar(now - RADAR_DAYS * DAY)).map(radarSignal),
  };

  const sources = {} as Record<ResearchSource, SourceStatus>;
  const signals: ResearchSignal[] = [];
  await Promise.all(
    (Object.keys(loaders) as ResearchSource[]).map(async (source) => {
      try {
        const got = await withTimeout(loaders[source](), ms);
        sources[source] = { state: "ok", count: got.length };
        if (source === "rule") pulse = rulePulse; // only from a load that made it in time
        for (const s of got) signals.push({ ...s, evidence: evidenceFor(deps.cache, s) });
      } catch (e) {
        if (!(e instanceof SourceUnavailable)) console.error(`[research] ${source}:`, e);
        sources[source] = { state: "unavailable", reason: msg(e), count: 0 };
      }
    }),
  );
  signals.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { asOf: new Date(now).toISOString(), signals, sources: { novelty: sources.novelty, rule: sources.rule, opportunity: sources.opportunity, radar: sources.radar }, pulse };
}
