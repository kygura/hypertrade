import { z } from "zod";
import { hlInfo, hlWeightWaitMs } from "../../shared/hl-client.js";
import type { PolledPosition } from "../../shared/platform.js";
import { envNum, type Info } from "./scanner.js";
import { rankCandidates } from "./priority.js";
import type { LoopDef } from "./runtime.js";
import type { PlatformStore } from "./store.js";

// Crawler (SPEC P0.4 crawler, P0.5-P0.6): polls clearinghouseState for the highest-priority
// addresses, at most PLATFORM_CRAWL_WEIGHT_PER_MIN / 2 polls a minute (default 500 weight = 250
// polls), and yields while the shared hlInfo weight guard is full (checked before every poll; the
// scanner's calls must not starve behind it). A tick where over 80% of polls fail throws, so health shows it.

const TICK_SEC = 5;
/** HL charges 2 for clearinghouseState and hl-client's guard books it at 2 (responseWeight), so the budget and the guard agree. */
const POLL_WEIGHT = 2;
const CONCURRENCY = 8;
const CANDIDATES = 1000;
/** Below this many polls in a tick one failure is noise, not an outage. */
const MIN_TRIED = 5;

const Num = z.union([z.string(), z.number()]).transform(Number).pipe(z.number().finite());
const Raw = z.object({ assetPositions: z.array(z.unknown()) });
const RawPos = z.object({
  position: z.object({
    coin: z.string().min(1),
    szi: Num,
    entryPx: Num,
    positionValue: Num,
    liquidationPx: Num.nullish(),
    leverage: z.object({ value: Num }).nullish(),
  }),
});

/** Defensive clearinghouseState parse: bad rows are skipped and counted, never thrown. Null when the envelope is wrong. */
export function parseClearinghouse(raw: unknown): { positions: PolledPosition[]; bad: number } | null {
  const env = Raw.safeParse(raw);
  if (!env.success) return null;
  const positions: PolledPosition[] = [];
  const seen = new Set<string>();
  let bad = 0;
  for (const row of env.data.assetPositions) {
    const r = RawPos.safeParse(row);
    const p = r.success ? r.data.position : null;
    if (!p || p.szi === 0 || !(p.entryPx > 0) || !(p.positionValue >= 0) || seen.has(p.coin)) {
      bad++;
      continue;
    }
    seen.add(p.coin);
    positions.push({
      coin: p.coin,
      szi: p.szi,
      entryPx: p.entryPx,
      positionValue: p.positionValue,
      liquidationPx: p.liquidationPx != null && p.liquidationPx > 0 ? p.liquidationPx : null,
      leverage: p.leverage && p.leverage.value > 0 ? p.leverage.value : null,
    });
  }
  return { positions, bad };
}

export interface CrawlerDeps {
  store: PlatformStore;
  info?: Info;
  now?: () => number;
  weightPerMin?: number;
  maxAgeMin?: number;
  /** ms the shared guard would make the next call wait; default: hl-client's. */
  guardWaitMs?: (now: number) => number;
}

export function createCrawler(deps: CrawlerDeps) {
  const { store } = deps;
  const info = deps.info ?? hlInfo;
  const now = deps.now ?? Date.now;
  const guard = deps.guardWaitMs ?? hlWeightWaitMs;
  const perMin = (deps.weightPerMin ?? envNum("PLATFORM_CRAWL_WEIGHT_PER_MIN", 500)) / POLL_WEIGHT;
  const maxAgeMin = deps.maxAgeMin ?? envNum("PLATFORM_CRAWL_MAX_AGE_MIN", 30);
  const polls: number[] = [];
  let tokens = 0;
  let last = now() - TICK_SEC * 1000;
  let bad = 0;
  let failed = 0;

  /** "skip": the shared guard was full, nothing was sent. */
  async function poll(address: string): Promise<"ok" | "fail" | "skip"> {
    if (guard(now()) > 0) return "skip";
    try {
      const parsed = parseClearinghouse(await info<unknown>({ type: "clearinghouseState", user: address }));
      if (!parsed) return void bad++, "fail";
      bad += parsed.bad;
      await store.savePoll(address, new Date(now()).toISOString(), parsed.positions);
      polls.push(now());
      return "ok";
    } catch {
      failed++;
      return "fail";
    }
  }

  async function tick() {
    const t = now();
    // Token bucket: refill at perMin, capped at two ticks' worth (no catch-up burst after a stall or an idle spell).
    tokens = Math.min(tokens + (perMin * Math.min(t - last, TICK_SEC * 1000)) / 60_000, (2 * perMin * TICK_SEC) / 60);
    last = t;
    while (polls.length && polls[0]! <= t - 60_000) polls.shift();
    const n = Math.floor(tokens);
    if (n < 1) return;
    const ranked = rankCandidates(await store.crawlCandidates({ idleBefore: new Date(t - 60 * 60_000).toISOString(), limit: CANDIDATES }), t, { maxAgeMin });
    const batch = ranked.slice(0, n);
    let tried = 0;
    let fails = 0;
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      tokens -= chunk.length;
      const res = await Promise.all(chunk.map((a) => poll(a.address)));
      const skipped = res.filter((r) => r === "skip").length;
      tokens += skipped; // unsent polls give their token back
      tried += res.length - skipped;
      fails += res.filter((r) => r === "fail").length;
      if (skipped) break;
    }
    if (tried >= MIN_TRIED && fails / tried > 0.8) throw new Error(`crawler: ${fails}/${tried} polls failed`);
  }

  return {
    tick,
    def: { name: "crawler", intervalSec: TICK_SEC, run: tick } satisfies LoopDef,
    pollsPerMin: () => polls.filter((p) => p > now() - 60_000).length,
    get bad() {
      return bad;
    },
    get failed() {
      return failed;
    },
  };
}
