import type { PlatformHealth } from "../../shared/platform.js";

// Loop supervisor (SPEC P0.4). Each loop runs in its own try/catch chain: a
// crash records an error and retries, it never stops the others or the API.

export interface LoopDef {
  name: string;
  /** Start-to-start cadence in seconds. */
  intervalSec: number;
  /** What health reports and staleness is judged against (default intervalSec): a long-poll run outlasts its cadence. */
  expectedIntervalSec?: number;
  run: () => Promise<void>;
}

export type LoopHealth = PlatformHealth["loops"][number];

export interface Loops {
  health(): LoopHealth[];
  stop(graceMs?: number): Promise<void>;
}

/** WORKER_LOOPS: unset or "all" -> every loop; "off" or "" -> none; otherwise a comma list. */
export function parseWorkerLoops(v: string | undefined): "all" | Set<string> {
  const s = (v ?? "all").trim().toLowerCase();
  if (s === "all") return "all";
  if (s === "off" || s === "") return new Set();
  return new Set(s.split(",").map((x) => x.trim()).filter(Boolean));
}

interface Opts {
  only?: "all" | Set<string>;
  now?: () => number;
  /** Minimum wait after a failed run, seconds. */
  errorBackoffSec?: number;
  log?: (...a: unknown[]) => void;
}

export function startLoops(defs: LoopDef[], opts: Opts = {}): Loops {
  const { only = "all", now = Date.now, errorBackoffSec = 5, log = console.error } = opts;
  const startedAt = now();
  let stopping = false;
  const wakers = new Set<() => void>();
  const inflight = new Set<Promise<void>>();
  const state = new Map<string, { lastBeatAt: number | null; error: string | null; expected: number }>();

  const sleep = (ms: number) => new Promise<void>((r) => {
    const wake = () => (clearTimeout(t), wakers.delete(wake), r());
    const t = setTimeout(wake, ms);
    wakers.add(wake);
  });

  for (const def of defs) {
    if (only !== "all" && !only.has(def.name)) continue;
    const s = { lastBeatAt: null as number | null, error: null as string | null, expected: def.expectedIntervalSec ?? def.intervalSec };
    state.set(def.name, s);
    const loop = (async () => {
      while (!stopping) {
        const t0 = now();
        let failed = false;
        try {
          await def.run();
          s.lastBeatAt = now();
          s.error = null;
        } catch (err) {
          failed = true;
          s.error = err instanceof Error ? err.message : String(err);
          log(`[loop:${def.name}]`, s.error);
        }
        if (stopping) break;
        await sleep(Math.max(failed ? errorBackoffSec * 1000 : 0, def.intervalSec * 1000 - (now() - t0)));
      }
    })();
    inflight.add(loop);
  }

  return {
    health() {
      const t = now();
      return [...state].map(([name, s]) => {
        const age = (t - (s.lastBeatAt ?? startedAt)) / 1000;
        return {
          name,
          lastBeatAt: s.lastBeatAt === null ? null : new Date(s.lastBeatAt).toISOString(),
          expectedIntervalSec: s.expected,
          ok: s.error === null && age <= 3 * s.expected,
          error: s.error,
        };
      });
    },
    async stop(graceMs = 5_000) {
      stopping = true;
      for (const wake of [...wakers]) wake();
      await Promise.race([Promise.all(inflight), new Promise((r) => setTimeout(r, graceMs).unref?.())]);
    },
  };
}

// /api/health extras: scripts/server.ts registers the provider; on Vercel none
// is set and /health keeps its original shape.
type HealthExtras = () => Promise<Partial<PlatformHealth>> | Partial<PlatformHealth>;
let healthExtras: HealthExtras | null = null;
export const setHealthExtras = (fn: HealthExtras | null) => void (healthExtras = fn);
export const getHealthExtras = () => healthExtras;
