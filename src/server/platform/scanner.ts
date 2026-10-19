import { hlInfo, parseMetaAndCtxs } from "../../shared/hl-client.js";
import { calendarEvents } from "../intel/calendar.js";
import { fin } from "../intel/util.js";
import type { JsonValue, LedgerStats, Opportunity } from "../../shared/platform.js";
import { bus as defaultBus, type Bus } from "./bus.js";
import { ABSORB_SHARE, bookFromL2, costs as costsFor, depthWithin, midOf, netEdge, type Book } from "./costs.js";
import { computeFeatures, liquidityTiers, type RingPoint } from "./features.js";
import { setupsFor } from "./setups.js";
import { nextAutoStatus, shouldExpire } from "./opportunity.js";
import { SCORE_VERSION, scoreOpportunity } from "./score.js";
import { groupStats } from "./stats.js";
import { dedupeKey, type OpportunityInput, type PlatformStore, type ScanSnapshot } from "./store.js";
import type { LoopDef } from "./runtime.js";
import { ensureSectors, parseUniverseSpec, selectUniverse, type UniverseOpts } from "./universe.js";

// Scan loop (SPEC P0.4 scanner, P0.9-P0.11). Thin glue: one metaAndAssetCtxs per
// tick -> ring -> features -> setups -> score -> upsert -> costs for the top N ->
// auto status -> expiry. All numbers come from the pure modules.

export type Info = typeof hlInfo;
export const envNum = (name: string, def: number): number => {
  const n = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(n) ? n : def;
};

const MIN = 60_000;
const RING_MS = 24 * 60 * MIN;
const PERSIST_MS = 5 * MIN;
/** Reference size for costs: min(absorbableUsd, this). Governor-free: the scanner has no account, the governor sizes at approval. */
export const REF_SIZE_USD = 10_000;
/** Holding time funding is charged over. ponytail: fixed 4 h (the middle outcome horizon); per-setup holds when the ledger says they differ. */
export const HOLD_HOURS = 4;
const LIQ_NEAR = 0.02;
const DAY_MS = 24 * 60 * MIN;

/** Maps NaN/±Infinity/undefined to null, recursively: the ledger rejects non-finite numbers. */
export function clean(v: unknown): JsonValue {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
  return (v ?? null) as JsonValue;
}
const px = (n: number) => Number(n.toPrecision(6));

/** Macro label (FOMC, CPI) for releases within one UTC day of `now`. A tag only: nothing reads it for score or status. */
function macroTags(now: Date): string[] {
  const today = Date.parse(now.toISOString().slice(0, 10));
  return calendarEvents(now).flatMap((e) => {
    const kind = e.entities[0]; // calendar.ts lists the macro kind first
    const days = Math.round((Date.parse(e.scheduledAt!.slice(0, 10)) - today) / DAY_MS);
    if ((kind !== "FOMC" && kind !== "CPI") || Math.abs(days) > 1) return [];
    return [`macro:${kind} ${days === 0 ? "today" : days === 1 ? "in 1 day" : "1 day ago"}`];
  });
}

export interface ScannerDeps {
  store: PlatformStore;
  info?: Info;
  now?: () => number;
  bus?: Bus;
  costTopN?: number;
  edgeMinN?: number;
  cooldownMin?: number;
  readyTtlMin?: number;
  researchScore?: number;
  /** Extra history for the ring at boot (e.g. intel_snapshots); the scan_snapshots row wins on a shared timestamp. */
  seedFrom?: (sinceIso: string) => Promise<ScanSnapshot[]>;
  /** Coins the setups run on (see parseUniverseSpec); default PLATFORM_SCAN_UNIVERSE, else every live coin. Tiers and the ring still cover all. */
  filter?: UniverseOpts;
  /** coin -> sectors for a sector filter; default tags new coins through the LLM and caches them in the store. */
  tags?: (coins: string[]) => Promise<Record<string, string[]>>;
}

export function createScanner(deps: ScannerDeps) {
  const { store } = deps;
  const info = deps.info ?? hlInfo;
  const now = deps.now ?? Date.now;
  const bus = deps.bus ?? defaultBus;
  const topN = deps.costTopN ?? envNum("PLATFORM_COST_TOP_N", 25);
  const edgeMinN = deps.edgeMinN ?? envNum("PLATFORM_EDGE_MIN_N", 30);
  const ttlMin = deps.readyTtlMin ?? envNum("PLATFORM_READY_TTL_MIN", 60);
  const researchScore = deps.researchScore ?? envNum("PLATFORM_RESEARCH_SCORE", 4);
  const intervalSec = envNum("PLATFORM_SCAN_INTERVAL_SEC", 60);
  const cooldownMs = (deps.cooldownMin ?? envNum("PLATFORM_COOLDOWN_MIN", 240)) * MIN;
  const spec = process.env.PLATFORM_SCAN_UNIVERSE?.trim();
  const filter = deps.filter ?? (spec ? parseUniverseSpec(spec) : undefined);
  const tags = deps.tags ?? ((coins: string[]) => ensureSectors(coins, store));

  const ring = new Map<string, RingPoint[]>();
  const marks = new Map<string, { px: number; ts: number }>();
  let seeded = false;
  let lastPersist = -Infinity;
  let lastScan: Date | null = null;

  /** Rebuilds the ring from the persisted 5-min snapshots (once, at the first tick). */
  async function seed() {
    const since = new Date(now() - RING_MS).toISOString();
    const own = await store.scanSnapshotsSince(since);
    // The extra source is best-effort: a missing table must not stop the scanner.
    const extra = await deps.seedFrom?.(since).catch((err) => (console.error("[scanner] seedFrom failed:", err instanceof Error ? err.message : err), [] as ScanSnapshot[])) ?? [];
    const merged = new Map<string, Map<number, RingPoint>>();
    for (const s of [...extra, ...own]) {
      const { mark, oiUsd, funding, dayNtlVlm } = s.inputs as Record<string, unknown>;
      const ts = Date.parse(s.ts);
      if (![ts, mark, oiUsd, funding, dayNtlVlm].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
      (merged.get(s.coin) ?? merged.set(s.coin, new Map()).get(s.coin)!).set(ts, { ts, mark: mark as number, oiUsd: oiUsd as number, funding: funding as number, dayNtlVlm: dayNtlVlm as number });
    }
    for (const [coin, m] of merged) ring.set(coin, [...m.values()].sort((a, b) => a.ts - b.ts));
    seeded = true;
  }

  async function bookOf(coin: string): Promise<Book | null> {
    try {
      return bookFromL2(await info<unknown>({ type: "l2Book", coin }));
    } catch {
      return null;
    }
  }

  async function tick() {
    const t = now();
    if (!seeded) await seed();
    const { ctxs } = parseMetaAndCtxs(await info<unknown>({ type: "metaAndAssetCtxs" }));
    const live = ctxs.filter((c) => !c.isDelisted && c.markPx > 0 && Number.isFinite(c.markPx));
    for (const c of live) {
      const pts = ring.get(c.name) ?? ring.set(c.name, []).get(c.name)!;
      pts.push({ ts: t, mark: c.markPx, oiUsd: c.openInterest * c.markPx, funding: c.funding, dayNtlVlm: c.dayNtlVlm });
      while (pts.length && pts[0]!.ts < t - RING_MS) pts.shift();
      marks.set(c.name, { px: c.markPx, ts: t });
    }
    if (t - lastPersist >= PERSIST_MS - 5_000) {
      const rows = live.map((c) => ({ coin: c.name, ts: new Date(t).toISOString(), inputs: { mark: c.markPx, oiUsd: c.openInterest * c.markPx, funding: c.funding, dayNtlVlm: c.dayNtlVlm } }))
        .filter((r) => Object.values(r.inputs).every(Number.isFinite));
      try {
        await store.insertScanSnapshots(rows);
        lastPersist = t;
      } catch (err) {
        console.error("[scanner] snapshot persist failed:", err instanceof Error ? err.message : err);
      }
    }

    // ponytail: reads every tracked position each scan; push the ±2% sum into SQL when the table outgrows this.
    const liqNear = new Map<string, number>();
    try {
      for (const p of await store.listPositions()) {
        const m = marks.get(p.coin)?.px;
        if (m && p.liquidationPx != null && Math.abs(p.liquidationPx - m) <= LIQ_NEAR * m) liqNear.set(p.coin, (liqNear.get(p.coin) ?? 0) + p.positionValue);
      }
    } catch (err) {
      console.error("[scanner] positions read failed:", err instanceof Error ? err.message : err);
    }

    const vols = live.map((c) => ({ coin: c.name, dayNtlVlm: c.dayNtlVlm }));
    const tiers = liquidityTiers(vols);
    const macro = macroTags(new Date(t));
    const scanned = filter && new Set(selectUniverse(vols, { ...filter, tags: filter.sectors?.length ? await tags(vols.map((c) => c.coin)) : undefined }).map((c) => c.coin));
    const cands = live.filter((c) => !scanned || scanned.has(c.name)).flatMap((c) => {
      const fv = computeFeatures(ring.get(c.name) ?? [], t, { liqNearUsd: liqNear.get(c.name) ?? null });
      const tier = tiers[c.name]!;
      return setupsFor(fv, tier).map((setup) => ({ ctx: c, fv, tier, setup, score: scoreOpportunity(fv) }));
    }).sort((a, b) => b.score - a.score);

    const books = new Map<string, Book | null>();
    for (const c of cands.slice(0, topN)) if (!books.has(c.ctx.name)) books.set(c.ctx.name, await bookOf(c.ctx.name));

    // Ledger mean net return per setup kind, from the 4 h group (the HOLD_HOURS the costs are charged over).
    const best = new Map<string, LedgerStats>();
    try {
      for (const g of groupStats(await store.outcomeRows({}))) if (g.horizon === "4h") best.set(g.setupKind, g);
    } catch (err) {
      console.error("[scanner] ledger stats failed:", err instanceof Error ? err.message : err);
    }

    let failed = 0;
    let lastErr: unknown;
    let firstMsg = "";
    const publish = (opportunity: Opportunity, change: "created" | "updated" | "status") => bus.publish("opportunity", { opportunity, change });
    for (const [i, c] of cands.entries()) {
      try {
        const { ctx, fv, setup, tier, score } = c;
        const mark = ctx.markPx;
        const input: OpportunityInput = {
          coin: ctx.name, direction: setup.direction, setupKind: setup.setupKind, tradeType: "directional", score, scoreVersion: SCORE_VERSION,
          tags: [...setup.tags, ...macro], liquidityTier: tier, regime: String(fv.inputs.regime ?? "unknown"),
          invalidation: `${setup.direction === "long" ? "Below" : "Above"} ${px(setup.invalidationPx)}: the thesis is dead`,
          entryPx: mark, stopPx: setup.stopPx, targetPx: setup.targetPx, invalidationPx: setup.invalidationPx,
        };
        const market = { mark, oraclePx: ctx.oraclePx, openInterest: ctx.openInterest, funding: ctx.funding, premium: ctx.premium, dayNtlVlm: ctx.dayNtlVlm, impactBidPx: ctx.impactBidPx, impactAskPx: ctx.impactAskPx };
        // Cooldown: a key whose last idea ended (rejected, expired, failed, closed) is not recreated until PLATFORM_COOLDOWN_MIN passes.
        const ended = await store.lastTerminalAt(dedupeKey({ coin: ctx.name, direction: setup.direction, setupKind: setup.setupKind }));
        if (ended && t - ended.getTime() < cooldownMs) continue;
        const r = await store.upsertOpportunity(input, clean({ features: fv, market, score, scoreVersion: SCORE_VERSION }) as never);
        let cur = r.opportunity;
        if (r.created) publish(cur, "created");

        const book = i < topN ? books.get(ctx.name) : null;
        if (book && cur.costs === null) {
          // Costs freeze at first computation: P0.13 nets outcomes against "the costs recorded at creation".
          const mid = midOf(book)!;
          const side = setup.direction === "long" ? book.asks : book.bids;
          const size = Math.min(ABSORB_SHARE * depthWithin(side, mid), REF_SIZE_USD);
          const cost = size > 0 ? costsFor({ book, sizeUsd: size, fundingHourly: ctx.funding, holdingHours: HOLD_HOURS, direction: setup.direction }) : null;
          if (cost) {
            const gross = (Math.abs(setup.targetPx - mark) / mark) * 1e4;
            const g = best.get(setup.setupKind);
            const ledger = g && g.clusters >= edgeMinN && g.meanNet != null;
            // net = gross − costs always holds: from the ledger the net is the 4 h mean, and gross is derived back from it.
            const net = ledger ? g.meanNet! * 1e4 : netEdge({ grossEdgeBps: gross, costs: cost });
            const grossEdge = ledger ? net + 2 * cost.feeBps + cost.slippageBps + cost.fundingBps : gross;
            const upd = await store.setOpportunityCosts(cur.id, { ...cost, grossEdgeBps: fin(grossEdge), netEdgeBps: fin(net), edgeBasis: ledger ? "ledger" : "unvalidated" });
            if (upd) (cur = upd, publish(cur, "updated"));
          }
        }
        for (let n = 0; n < 3; n++) {
          const to = nextAutoStatus(cur, { researchScore, researchAllowed: false }); // ponytail: auto-investigating needs the research budget gate; operator-driven for now
          const moved = to && (await store.transitionOpportunity(cur.id, cur.status, to, "system"));
          if (!moved) break;
          cur = moved;
          publish(cur, "status");
        }
      } catch (err) {
        failed++;
        lastErr = err;
        firstMsg ||= err instanceof Error ? err.message : String(err);
      }
    }
    if (failed) console.error(`[scanner] ${failed}/${cands.length} candidates failed, first:`, firstMsg); // once per scan, not per candidate
    if (cands.length && failed === cands.length) throw lastErr;

    for (const o of await store.listOpportunities({ statuses: ["ready"], limit: 500 })) {
      if (!shouldExpire(o, new Date(t), ttlMin)) continue;
      const e = await store.transitionOpportunity(o.id, "ready", "expired", "system");
      if (e) publish(e, "status");
    }

    lastScan = new Date(t);
    bus.publish("scan", { ts: lastScan.toISOString(), assets: live.length });
  }

  return {
    tick,
    def: { name: "scanner", intervalSec, run: tick } satisfies LoopDef,
    intervalSec,
    lastScanAt: () => lastScan,
    /** Minutes of ring history for the median coin; null while the ring is empty. */
    historyMin: () => {
      const spans = [...ring.values()].filter((p) => p.length).map((p) => (p.at(-1)!.ts - p[0]!.ts) / MIN).sort((a, b) => a - b);
      return spans.length ? spans[Math.floor(spans.length / 2)]! : null;
    },
    /** Mark from the latest scan, for the outcomes fallback; null once older than 2 × the scan interval. */
    latestMark: (coin: string) => {
      const m = marks.get(coin);
      return m && now() - m.ts <= 2 * intervalSec * 1000 ? m.px : null;
    },
  };
}
