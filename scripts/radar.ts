// bun run radar [--save]           scan every live perp on every HL dex, print the digest; --save also writes data/radar/state.json
// bun run radar land <calls.json>  validate the session's calls against the last scan, stamp prices, append to data/radar/calls.json
// bun run radar score              grade past calls against data/radar/state.json and print the scorecard
// bun run radar seed               one-off: backfill the 9 days before today from daily candles (liquid markets only)
// ROUTINE.md runs these. Public HL info API only: no keys, no database. The last scan is kept in /tmp/run/radar-scan.json
// so `land` stamps the same prices the session read.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchCandles, fetchPerpDexs, fetchPerpMetaAndCtxs, fetchPerpsAtOpenInterestCap } from "../src/shared/hl-client.js";
import { RadarCallsFileSchema, RadarCallsInputSchema, RadarStateSchema, type RadarCallsFile, type RadarState } from "../src/shared/radar.js";
import { gradeCalls, landCalls, scorecard } from "../src/server/radar/calls.js";
import { digest, formatDigest, nextState, RADAR, seedDays, toMarkets, type DexBook, type RadarMarket } from "../src/server/radar/scan.js";
import type { Candle } from "../src/shared/types.js";
import { runDate } from "../src/server/routine/run.js";

const STATE = "data/radar/state.json";
const CALLS = "data/radar/calls.json";
const SCAN = "/tmp/run/radar-scan.json";
const MAX_SCAN_AGE_MS = 2 * 3_600_000;

const [cmd, ...rest] = process.argv.slice(2);
const save = process.argv.includes("--save");

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 1)}\n`);
  await rename(`${path}.tmp`, path);
}

const readState = async (): Promise<RadarState> => RadarStateSchema.parse((await readJson(STATE)) ?? {});
const readCalls = async (): Promise<RadarCallsFile> => RadarCallsFileSchema.parse((await readJson(CALLS)) ?? {});

async function fetchBooks(gaps: string[]): Promise<DexBook[]> {
  const books: DexBook[] = [];
  try {
    books.push({ dex: "", ctxs: (await fetchPerpMetaAndCtxs(fetch)).ctxs });
  } catch (e) {
    console.error(`main dex unavailable (${e instanceof Error ? e.message : String(e)}): no radar this run`);
    process.exit(1);
  }
  let dexes: string[] = [];
  try {
    dexes = (await fetchPerpDexs(fetch)).map((d) => d.name);
  } catch (e) {
    gaps.push(`HIP-3 dex list: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const dex of dexes) {
    try {
      books.push({ dex, ctxs: (await fetchPerpMetaAndCtxs(fetch, dex)).ctxs });
    } catch (e) {
      gaps.push(`dex ${dex}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return books;
}

async function scan() {
  const now = new Date();
  const today = runDate(now);
  const gaps: string[] = [];
  const books = await fetchBooks(gaps);
  let cap = new Set<string>();
  try {
    cap = new Set(await fetchPerpsAtOpenInterestCap(fetch));
  } catch (e) {
    gaps.push(`OI cap list: ${e instanceof Error ? e.message : String(e)}`);
  }
  const markets = toMarkets(books, cap);
  const state = await readState();
  console.log(formatDigest(digest(markets, state, today), gaps));
  await writeJson(SCAN, { at: now.toISOString(), date: today, markets });
  if (save) await writeJson(STATE, nextState(state, markets, today, now.toISOString()));
}

async function seed() {
  const today = runDate(new Date());
  const gaps: string[] = [];
  const liquid = toMarkets(await fetchBooks(gaps), new Set()).filter((m) => m.vol24h >= RADAR.minVolUsd);
  const start = Date.parse(`${today}T00:00:00Z`) - (RADAR.weekMaxDays + 1) * 86_400_000;
  const candles = new Map<string, Candle[]>();
  for (const m of liquid) {
    try {
      candles.set(m.key, await fetchCandles(m.key, "1d", start));
    } catch (e) {
      gaps.push(`${m.key} candles: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const state = seedDays(await readState(), candles, today);
  await writeJson(STATE, state);
  console.log(`seeded ${candles.size} of ${liquid.length} liquid markets; state holds ${state.days.length} days${gaps.length ? `\ngaps: ${gaps.join("; ")}` : ""}`);
}

async function land(path: string | undefined) {
  if (!path) throw new Error("usage: bun run radar land <calls.json>");
  const saved = (await readJson(SCAN)) as { at: string; date: string; markets: RadarMarket[] } | null;
  if (!saved || Date.now() - Date.parse(saved.at) > MAX_SCAN_AGE_MS) throw new Error(`${SCAN} missing or older than 2 h: run \`bun run radar\` again first`);
  const input = RadarCallsInputSchema.safeParse(await readJson(path));
  if (!input.success) {
    console.error(`calls rejected: ${input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    process.exit(1);
  }
  const r = landCalls(input.data.calls, saved.markets, await readCalls(), saved.date, saved.at);
  const graded = gradeCalls(r.file, await readState());
  await writeJson(CALLS, graded);
  for (const c of r.landed) console.log(`landed ${c.id} · ${c.stance} ${c.market} at ${c.mark} (BTC ${c.btc})`);
  for (const x of r.rejected) console.log(`dropped ${x.market}: ${x.reason}`);
  console.log(scorecard(graded).join("\n"));
}

async function score() {
  const graded = gradeCalls(await readCalls(), await readState());
  await writeJson(CALLS, graded);
  console.log(scorecard(graded).join("\n"));
}

if (!cmd || cmd === "--save") await scan();
else if (cmd === "land") await land(rest[0]);
else if (cmd === "score") await score();
else if (cmd === "seed") await seed();
else {
  console.error("usage: bun run radar [--save] | land <calls.json> | score | seed");
  process.exit(2);
}
