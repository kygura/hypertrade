// bun run radar [--save]                      scan every live perp on every HL dex and print the digest; --save also
//                                             writes today's snapshot to data/radar/state.json (full runs only)
// bun run radar show <MARKET...> [--since D]  one market's full line, its daily marks and its move since date D
// bun run radar land <calls.json>             validate calls against the last scan, stamp prices, append to
//                                             data/radar/calls.json, write /tmp/run/push.txt
// bun run radar score                         grade past calls, report crossed kill levels once, print the scorecard
// bun run radar seed                          one-off: backfill the 9 days before today from daily candles
// ROUTINE.md runs these. Public HL info API only: no keys, no database. The last scan is kept in
// /tmp/run/radar-scan.json so `show`, `land` and `score` read the same prices the session read.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchCandles, fetchPerpDexs, fetchPerpMetaAndCtxs, fetchPerpsAtOpenInterestCap } from "../src/shared/hl-client.js";
import { RadarCallsFileSchema, RadarCallsInputSchema, RadarStateSchema, type RadarCallsFile, type RadarState } from "../src/shared/radar.js";
import type { AssetCtx, Candle } from "../src/shared/types.js";
import { checkKills, gradeCalls, landCalls, scorecard } from "../src/server/radar/calls.js";
import { collectMacro, macroLines } from "../src/server/radar/macro.js";
import { digest, formatDigest, nextState, RADAR, seedDays, showMarkets, toMarkets, type DexBook, type RadarMarket } from "../src/server/radar/scan.js";
import { runDate } from "../src/server/routine/run.js";

const STATE = "data/radar/state.json";
const CALLS = "data/radar/calls.json";
const SCAN = "/tmp/run/radar-scan.json";
const PUSH = "/tmp/run/push.txt";
const MAX_SCAN_AGE_MS = 2 * 3_600_000;
/** HL rate-limits bursts with 429s for up to a minute; the client's own retry waits 0.5 s. */
const MAIN_DEX_RETRY_MS = [20_000, 40_000];

const argv = process.argv.slice(2);
const [cmd] = argv;
const flagValue = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path}: ${msg(e)}`);
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 1)}\n`);
  await rename(`${path}.tmp`, path);
}

const readState = async (): Promise<RadarState> => RadarStateSchema.parse((await readJson(STATE)) ?? {});
const readCalls = async (): Promise<RadarCallsFile> => RadarCallsFileSchema.parse((await readJson(CALLS)) ?? {});

interface SavedScan {
  at: string;
  date: string;
  markets: RadarMarket[];
}

async function readScan(): Promise<SavedScan> {
  const saved = (await readJson(SCAN)) as SavedScan | null;
  if (!saved || Date.now() - Date.parse(saved.at) > MAX_SCAN_AGE_MS) throw new Error(`${SCAN} missing or older than 2 h: run \`bun run radar\` first`);
  return saved;
}

async function mainDex(): Promise<AssetCtx[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await fetchPerpMetaAndCtxs(fetch)).ctxs;
    } catch (e) {
      const wait = MAIN_DEX_RETRY_MS[attempt];
      if (wait == null) throw e;
      console.error(`main dex: ${msg(e)}; retrying in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

interface Books {
  books: DexBook[];
  names: Record<string, string>;
  failed: string[];
  gaps: string[];
}

async function fetchBooks(): Promise<Books> {
  const out: Books = { books: [], names: { main: "main" }, failed: [], gaps: [] };
  try {
    out.books.push({ dex: "", ctxs: await mainDex() });
  } catch (e) {
    console.error(`main dex unavailable after retries (${msg(e)}): no radar this run`);
    process.exit(1);
  }
  let dexes: { name: string; fullName: string }[] = [];
  try {
    dexes = await fetchPerpDexs(fetch);
  } catch (e) {
    out.gaps.push(`HIP-3 dex list: ${msg(e)}`);
  }
  for (const d of dexes) {
    out.names[d.name] = d.fullName;
    try {
      out.books.push({ dex: d.name, ctxs: (await fetchPerpMetaAndCtxs(fetch, d.name)).ctxs });
    } catch (e) {
      out.failed.push(d.name);
      out.gaps.push(`dex ${d.name}: ${msg(e)}`);
    }
  }
  return out;
}

async function scan() {
  const now = new Date();
  const today = runDate(now);
  // Keyless macro sources, started first so they overlap the dex fetches. Print-only: nothing macro is saved, and
  // a failure here is a gap line, never an exit code.
  const macroP = collectMacro(fetch, now)
    .then((m) => macroLines(m, now))
    .catch((e) => {
      console.error(`macro: ${msg(e)}`);
      return ["macro gaps: the macro block failed (see stderr)"];
    });
  const { books, names, failed, gaps } = await fetchBooks();
  const cap = new Set<string>();
  for (const b of books) {
    try {
      for (const k of await fetchPerpsAtOpenInterestCap(fetch, b.dex || undefined)) cap.add(k);
    } catch (e) {
      gaps.push(`OI cap ${b.dex || "main"}: ${msg(e)}`);
    }
  }
  const markets = toMarkets(books, cap);
  const state = await readState();
  console.log(formatDigest(digest(markets, state, today), gaps, names, await macroP));
  await writeJson(SCAN, { at: now.toISOString(), date: today, markets } satisfies SavedScan);
  if (argv.includes("--save")) await writeJson(STATE, nextState(state, markets, today, now.toISOString(), failed));
}

async function show() {
  const keys = argv.slice(1).filter((a, i, all) => a !== "--since" && all[i - 1] !== "--since");
  if (!keys.length) throw new Error("usage: bun run radar show <MARKET...> [--since YYYY-MM-DD]");
  const saved = await readScan();
  console.log(showMarkets(saved.markets, await readState(), keys, flagValue("--since")).join("\n"));
}

async function land(path: string | undefined) {
  if (!path) throw new Error("usage: bun run radar land <calls.json>");
  const saved = await readScan();
  const input = RadarCallsInputSchema.safeParse(await readJson(path));
  if (!input.success) {
    console.error(`calls rejected: ${input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    process.exit(1);
  }
  const state = await readState();
  const r = landCalls(input.data.calls, saved.markets, state, await readCalls(), saved.date, saved.at);
  await writeJson(CALLS, gradeCalls(r.file, state));
  for (const l of r.landed) console.log(`landed ${l.call.id}\n${l.line}`);
  for (const x of r.rejected) console.log(`dropped ${x.market}: ${x.reason}`);
  // The push carries only what landed, with the numbers code printed. Appends after `score`'s kill lines.
  if (r.landed.length) await writeFile(PUSH, `${r.landed.map((l) => l.line).join("\n")}\n`, { flag: "a" });
}

async function score() {
  let file = gradeCalls(await readCalls(), await readState());
  const saved = await readScan().catch(() => null);
  if (saved) {
    const k = checkKills(file, saved.markets, saved.date);
    file = k.file;
    if (k.killed.length) {
      console.log(k.killed.join("\n"));
      await mkdir(dirname(PUSH), { recursive: true });
      await writeFile(PUSH, `${k.killed.join("\n")}\n`, { flag: "a" });
    }
  } else console.log("kill check skipped: no scan from the last 2 h");
  await writeJson(CALLS, file);
  console.log(scorecard(file).join("\n"));
}

async function seed() {
  const today = runDate(new Date());
  const { books, gaps } = await fetchBooks();
  const liquid = toMarkets(books, new Set()).filter((m) => m.vol24h >= RADAR.minVolUsd);
  const start = Date.parse(`${today}T00:00:00Z`) - (RADAR.weekMaxDays + 2) * 86_400_000;
  const candles = new Map<string, Candle[]>();
  for (const m of liquid) {
    try {
      candles.set(m.key, await fetchCandles(m.key, "1d", start));
    } catch (e) {
      gaps.push(`${m.key} candles: ${msg(e)}`);
    }
  }
  const state = seedDays(await readState(), candles, today);
  await writeJson(STATE, state);
  console.log(`seeded ${candles.size} of ${liquid.length} liquid markets; state holds ${state.days.length} days${gaps.length ? `\ngaps: ${gaps.join("; ")}` : ""}`);
}

if (!cmd || cmd === "--save") await scan();
else if (cmd === "show") await show();
else if (cmd === "land") await land(argv[1]);
else if (cmd === "score") await score();
else if (cmd === "seed") await seed();
else {
  console.error("usage: bun run radar [--save] | show <MARKET...> [--since YYYY-MM-DD] | land <calls.json> | score | seed");
  process.exit(2);
}
