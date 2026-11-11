import { Hono } from "hono";
import { z } from "zod";
import { computeCycle } from "../../shared/cycles.js";
import type { VectorResponse } from "../../shared/vector.js";
import { buildVector } from "../../shared/vectorModel.js";
import { errDetail } from "../radar/macro.js";
import { createVectorLoaders, defaultVectorIo, mergeSeries, type Loader, type SeriesMap, type SourceData } from "../vector/sources.js";

export type { VectorResponse };

// GET /vector
//
// The BTC Vector (ported from hl-cycles, docs/MODEL.md §8 there): the four-state
// risk regime, the Market Compass lenses, key on-chain levels, the daily brief,
// gauges and the macro strip, all over daily data. Each source loads on its own
// and is reported in `sources` with lastOk/lastError: a failing source keeps its
// last good data (or, never loaded, leaves its inputs null) and never fails the
// route. Sources refresh at most every SOURCE_TTL_MS; the computed body is shared
// until one of them does.

/** Daily data: a source is re-fetched at most this often. */
export const SOURCE_TTL_MS = 6 * 60 * 60_000;
/** After a failure, the next attempt waits this long (bitcoin-data: longer, see SOURCE_RETRY_MS). */
export const FAIL_RETRY_MS = 30 * 60_000;
/** Per-source overrides of FAIL_RETRY_MS: bitcoin-data's keyless quota is 10/hour and 15/day. */
const SOURCE_RETRY_MS: Record<string, number> = { bgeometrics: 3 * 60 * 60_000 };
/** One source's load is abandoned (reported as a timeout) after this long. */
export const SOURCE_TIMEOUT_MS = 180_000; // no-DB cold start: HL funding + alts share the weight guard (~60 s each measured)

export type VectorDeps = {
  now: () => number;
  /** One loader per reported source name; see vector/sources.ts createVectorLoaders. */
  sources: () => Record<string, Loader>;
};

export const defaultVectorDeps: VectorDeps = {
  now: () => Date.now(),
  sources: () => createVectorLoaders(defaultVectorIo()),
};

type SourceState = { data: SourceData | null; lastOk: number | null; lastError: string | null; at: number; failed: boolean };

function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

/** The model over whatever the sources hold; a source without data contributes nothing (its inputs read null). */
export function assembleVector(states: Record<string, SourceState>, now: number): VectorResponse {
  let series: SeriesMap = {};
  const data = Object.values(states).map((s) => s.data).filter((d): d is SourceData => d != null);
  for (const d of data) if (d.series) series = mergeSeries(series, d.series);
  const daily = data.find((d) => d.daily)?.daily ?? [];
  return buildVector({
    htf: computeCycle(daily, now),
    series,
    funding: data.find((d) => d.funding)?.funding ?? [],
    oi: data.find((d) => d.oi)?.oi ?? [],
    alts: data.find((d) => d.alts)?.alts ?? [],
    sources: Object.fromEntries(Object.entries(states).map(([k, s]) => [k, { lastOk: s.lastOk, lastError: s.lastError }])),
  });
}

export function vectorRoute(deps: VectorDeps = defaultVectorDeps) {
  let loaders: Record<string, Loader> | null = null;
  const states: Record<string, SourceState> = {};
  let body: VectorResponse | null = null;
  let inflight: Promise<VectorResponse> | null = null;

  const due = (name: string, now: number) => {
    const s = states[name];
    if (!s) return true;
    return now - s.at >= (s.failed ? (SOURCE_RETRY_MS[name] ?? FAIL_RETRY_MS) : SOURCE_TTL_MS);
  };

  async function refresh(): Promise<VectorResponse> {
    loaders ??= deps.sources();
    const now = deps.now();
    const names = Object.keys(loaders).filter((n) => due(n, now));
    if (body && names.length === 0) return body;
    await Promise.all(
      names.map(async (name) => {
        const prev = states[name];
        try {
          const data = await timeout(loaders![name]!(now), SOURCE_TIMEOUT_MS, name);
          states[name] = { data, lastOk: data.fetchedAt ?? now, lastError: data.error ?? null, at: now, failed: false };
        } catch (err) {
          const msg = err instanceof Error && !(err instanceof z.ZodError) ? err.message.slice(0, 300) : errDetail(err);
          console.warn(`[vector] ${name} failed: ${msg}`);
          // Last good data stays in the model; lastOk keeps its date so staleness shows.
          states[name] = { data: prev?.data ?? null, lastOk: prev?.lastOk ?? null, lastError: msg, at: now, failed: true };
        }
      }),
    );
    body = assembleVector(states, now);
    return body;
  }

  return new Hono().get("/", async (c) => {
    if (!inflight) inflight = refresh().finally(() => (inflight = null));
    return c.json(await inflight);
  });
}

export const vectorRoutes = vectorRoute();
