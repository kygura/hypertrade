import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { telegramApi } from "../desk/notify.js";
import { payloadNumbers } from "../intel/numbers.js";
import type { AnalystEnv } from "../llm/provider.js";
import { myMarkets } from "../platform/universe.js";
import { appendSnapshot, BoardHistorySchema, type Board, type BoardHistory } from "./board.js";
import { collect, collectBoard, MAJORS, type ContextPack, type HlClient } from "./collect.js";
import { gateProposals, type GateProposal, type Rejection } from "./gate.js";
import { htfFeatures, type HtfFeatures } from "./htf.js";
import { advanceSetup, cancelSetup, emptyLedger, entryMid, settleLedger } from "./ledger.js";
import { anyProviderConfigured, callChain, DEFAULT_MAX_USD, envProviderFactory, MemoryLlmCache, parseChain, type ChainAttempt, type ChainResult, type ProviderFactory } from "./llm.js";
import { DAILY_PROMPT_VERSION, DAILY_SYSTEM, dailyUser, numbersBlock, SCAN_PROMPT_VERSION, SCAN_SYSTEM, scanUser } from "./prompts.js";
import { checkWatchlist, resolveDraft, unanswered, watchKey } from "./scan.js";
import {
  DailyOutputSchema,
  DISCLAIMER,
  HtfViewSchema,
  LedgerSchema,
  MarketStateDataSchema,
  ScanOutputSchema,
  SectorsDataSchema,
  toJsonSchema,
  WatchItemSchema,
  type HtfView,
  type Ledger,
  type ScanOutput,
  type Setup,
  type WatchItem,
} from "./schema.js";
import { evaluateTripwires, formatTripwire, tripwireKey, type TripwireRead } from "./tripwires.js";

// The routine's orchestration (docs/fallback-routine.md § Pipeline per run):
// load state → collect → board + tripwires → settle open setups against
// prices → model (or --input) → resolve levels, gate → write → brief →
// notify. Everything with a side effect (fetch, provider, clock, filesystem
// root, Telegram) comes in through RunDeps so a test can drive a whole run
// against a temp directory.

export type Mode = "scan" | "daily";

export interface RunOptions {
  mode: Mode;
  dryRun: boolean;
  /** Collect and print the scan prompt (rules + board); no model, no writes. With `context`, also save the collection there. */
  collectOnly?: boolean;
  /** A scan output produced by an external agent (--input): replaces the model call, no provider needed. */
  input?: unknown;
  /** A saved collection: written by --collect-only, read with --input so the input resolves against the board it was written from. */
  context?: string;
  /** When the run is worth a notification, its push text is written here (the Claude routine sends it through ntfy). */
  pushOut?: string;
  /** Repo root: data/ lives under it. */
  root: string;
}

export interface RunDeps {
  env: Record<string, string | undefined>;
  now(): Date;
  fetch?: typeof fetch;
  makeProvider?: ProviderFactory;
  hl?: HlClient;
  log(line: string): void;
}

export interface RunResult {
  exitCode: number;
  wrote: string[];
  brief: string;
  /** The push text, when something new happened; null = a quiet run. */
  push: string | null;
  notified: boolean;
  rejected: Rejection[];
  gaps: ContextPack["gaps"];
}

const TELEGRAM_LIMIT = 3900;
/** An --input run refuses a saved collection older than this: its board no longer describes the market. */
export const MAX_CONTEXT_AGE_MS = 2 * 3_600_000;
const jsonText = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;

/** data/board/latest.json: what the last scan saw and said, for the next run's deltas. */
export const ScanRecordSchema = z.object({
  generated_at: z.string(),
  read: z.string(),
  watchlist: z.array(WatchItemSchema),
  hits: z.array(z.object({ asset: z.string(), setup_id: z.string(), direction: z.string() })),
  near: z.array(z.object({ asset: z.string(), setup_id: z.string(), direction: z.string(), gap: z.number().nullable() })),
  new_setups: z.array(z.string()),
  rejected: z.array(z.object({ asset: z.string(), direction: z.string(), rule: z.string(), detail: z.string() })),
  passes: z.array(z.object({ asset: z.string(), template: z.string(), direction: z.string(), reason: z.string() })),
  unanswered: z.array(z.string()),
  brief: z.string(),
});
export type ScanRecord = z.infer<typeof ScanRecordSchema>;

const SavedContextSchema = z.object({ version: z.literal(1), pack: z.object({ asOf: z.string() }).passthrough(), board: z.object({ asOf: z.string(), rows: z.array(z.unknown()) }).passthrough() });

/** YYYY-MM-DD in Atlantic/Canary (ROUTINE.md §1: the routine's execution date). */
export function runDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Atlantic/Canary", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function latestDated(dir: string, exclude?: string): Promise<string | null> {
  try {
    const files = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${exclude}.json`).sort();
    return files.length ? join(dir, files.at(-1)!) : null;
  } catch {
    return null;
  }
}

/** Adds `import dYYYYMMDD from "./date.json"` and its array entry to a history index; no-op when the date is there. */
export function registerDate(index: string, date: string): string {
  if (index.includes(`"./${date}.json"`)) return index;
  const v = `d${date.replace(/-/g, "")}`;
  const importLine = `import ${v} from "./${date}.json" with { type: "json" };`;
  const lines = index.split("\n");
  const lastImport = lines.map((l, i) => (l.startsWith("import ") ? i : -1)).filter((i) => i >= 0).at(-1);
  const close = lines.lastIndexOf("];");
  if (lastImport === undefined || close < 0) throw new Error("history index has an unexpected shape");
  lines.splice(close, 0, `  { date: "${date}", data: ${v} },`);
  lines.splice(lastImport + 1, 0, importLine);
  return lines.join("\n");
}

/** Plain-text messages under Telegram's limit, split on line boundaries. */
export function splitMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    for (let piece = line; ; ) {
      const room = limit - (cur ? cur.length + 1 : 0);
      if (piece.length <= room) {
        cur = cur ? `${cur}\n${piece}` : piece;
        break;
      }
      if (cur) {
        out.push(cur);
        cur = "";
        continue;
      }
      out.push(piece.slice(0, limit));
      piece = piece.slice(limit);
      if (!piece) break;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function notifyTelegram(env: RunDeps["env"], text: string, f: typeof fetch, log: RunDeps["log"]): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) {
    log("telegram: not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
    return false;
  }
  try {
    for (const part of splitMessage(text)) {
      const res = await telegramApi(token, "sendMessage", { chat_id: chat, text: part, disable_web_page_preview: true }, f);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
    return true;
  } catch (e) {
    log(`telegram: send failed (${e instanceof Error ? e.message : String(e)})`);
    return false;
  }
}

export function packSummary(pack: ContextPack, htf: Record<string, HtfFeatures | null>, board: Board, tripwires: { hits: TripwireRead[]; near: TripwireRead[] }): string {
  const lines = [`context pack @ ${pack.asOf}`];
  lines.push(`  hyperliquid: ${pack.hl ? `${pack.hl.universeSize} live symbols` : "missing"} · board ${board.rows.length} markets · OI history ${board.history.snapshots} snapshots`);
  lines.push(`  tripwires: ${tripwires.hits.length} hits (${tripwires.hits.map((t) => `${t.asset} ${t.setup_id} ${t.direction}`).join(", ") || "none"}), ${tripwires.near.length} near`);
  for (const coin of MAJORS) {
    const h = htf[coin];
    if (h) lines.push(`  ${coin}: close ${h.close} · vs20W ${h.vs20wPct}% · vs200D ${h.vs200dPct}% · rv30 ${h.rv30Pct}% · trend ${h.trend}`);
  }
  const c = pack.hlCycles;
  lines.push(`  hl-cycles: ${c ? `${c.regime?.state ?? "?"} since ${c.regime?.since ?? "?"} · ${c.levels.length} levels · compass ${c.compass?.score ?? "?"}${c.stale ? " · STALE" : ""}` : "missing"}`);
  if (Object.keys(pack.fred).length) lines.push(`  fred: ${Object.entries(pack.fred).map(([k, v]) => `${k} ${v.at(-1)?.value} (${v.at(-1)?.date})`).join(", ")}`);
  if (Object.keys(pack.yahoo).length) lines.push(`  yahoo: ${Object.entries(pack.yahoo).map(([k, v]) => `${k} ${v.price}`).join(", ")}`);
  if (pack.fng) lines.push(`  fear&greed: ${pack.fng.value} ${pack.fng.label}`);
  if (pack.stablecoins) lines.push(`  stablecoins: $${(pack.stablecoins.nowUsd / 1e9).toFixed(1)}B (7d ${pack.stablecoins.d7Pct}%, 30d ${pack.stablecoins.d30Pct}%)`);
  lines.push(`  app: ${pack.app ? `${pack.app.metrics.length} metrics, ${pack.app.unusual.length} unusual` : "not used"} · lab: ${pack.lab ? `pulse ${pack.lab.pulse ? "ok" : "failed"}, catalogue ${pack.lab.catalogue?.length ?? "failed"}` : "not used"}`);
  lines.push(`  next catalysts: ${pack.calendar.map((e) => `${e.kind} ${e.at.slice(0, 10)}`).join(", ")}`);
  lines.push(`  open-setup paths: ${Object.entries(pack.path).map(([k, v]) => `${k} ${v.length}h`).join(", ") || "none"}`);
  lines.push(`gaps (${pack.gaps.length}):`);
  for (const g of pack.gaps) lines.push(`  - ${g.source}: ${g.status} — ${g.detail}`);
  return lines.join("\n");
}

/** Ledger JSON without the check timestamps (top-level and per-setup updated_at). */
const stripTimes = (l: Ledger) => JSON.stringify({ ...l, updated_at: null, open: l.open.map((s) => ({ ...s, updated_at: null })) });

const fmtSetup = (s: Setup) =>
  `${s.id}: ${s.asset} ${s.direction} ${s.timeframe ?? s.horizon}${s.setup_id ? ` ${s.setup_id}` : ""}, entry ${s.entry.low}–${s.entry.high}, invalidation ${s.invalidation} (${s.invalidation_reason}), targets ${s.targets.join("/")}, ${s.rr}R, ${s.conviction} conviction${s.regime_alignment === "counter" ? " (counter-trend)" : ""}. Trigger: ${s.trigger}`;

const pctFrom = (a: number, b: number) => Math.round(((a - b) / b) * 1000) / 10;

/** Previous scan record; a missing or unreadable one counts as a first run (everything is new). */
async function readScanRecord(path: string, notes: string[]): Promise<ScanRecord | null> {
  try {
    const raw = await readJson(path);
    return raw === null ? null : ScanRecordSchema.parse(raw);
  } catch {
    notes.push("data/board/latest.json unreadable: deltas start over this run");
    return null;
  }
}

async function readHistory(path: string, notes: string[]): Promise<BoardHistory | null> {
  try {
    const raw = await readJson(path);
    return raw === null ? null : BoardHistorySchema.parse(raw);
  } catch {
    // Derived data: losing it costs the OI deltas for a while, not a decision.
    notes.push("data/board/history.json unreadable: OI history starts over this run");
    return null;
  }
}

export async function runRoutine(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const { env, log } = deps;
  const f = deps.fetch ?? fetch;
  const now = deps.now();
  const nowIso = now.toISOString();
  const date = runDate(now);
  const dataDir = join(opts.root, "data");
  const setupsDir = join(dataDir, "setups");
  const boardDir = join(dataDir, "board");
  const result: RunResult = { exitCode: 0, wrote: [], brief: "", push: null, notified: false, rejected: [], gaps: [] };

  // The workflow names the daily commit after the run's own date, not a second clock read.
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `run_date=${date}\n`).catch((e) => log(`GITHUB_OUTPUT: ${e instanceof Error ? e.message : String(e)}`));

  const external = opts.input !== undefined;
  if (external && opts.mode === "daily") {
    log("--input supports scan mode only; daily needs a model to write MarketState and Sectors");
    return { ...result, exitCode: 2 };
  }
  const chain = parseChain(env.ROUTINE_LLM);
  for (const e of chain.errors) log(`ROUTINE_LLM: ignored ${e}`);
  if (!opts.collectOnly && !external && !chain.entries.length) {
    // A misconfigured chain is an error, unlike a missing key (exit 0 below).
    log(`ROUTINE_LLM has no usable entry: ${chain.errors.join("; ")}`);
    return { ...result, exitCode: 1 };
  }
  const makeProvider = deps.makeProvider ?? envProviderFactory(env as AnalystEnv);
  if (!opts.collectOnly && !external && !anyProviderConfigured(chain.entries, makeProvider)) {
    log(`no LLM provider configured (ROUTINE_LLM=${env.ROUTINE_LLM?.trim() || "default"}; set the key for one of its providers). Nothing to do.`);
    return result;
  }

  // 1. State. A ledger or view that exists but does not parse stops the run: overwriting it would lose history.
  const notes: string[] = [];
  const rawLedger = await readJson(join(setupsDir, "ledger.json"));
  const ledger0: Ledger = rawLedger === null ? emptyLedger(now) : LedgerSchema.parse(rawLedger);
  const rawView = await readJson(join(setupsDir, "htf.json"));
  const view: HtfView | null = rawView === null ? null : HtfViewSchema.parse(rawView);
  const history0 = await readHistory(join(boardDir, "history.json"), notes);
  const prev = await readScanRecord(join(boardDir, "latest.json"), notes);

  // 2. Collect: the context pack and the board, or the saved collection an --input was written from.
  let pack: ContextPack;
  let board: Board;
  if (external && opts.context) {
    const saved = SavedContextSchema.parse(JSON.parse(await readFile(opts.context, "utf8")));
    const age = now.getTime() - Date.parse(saved.board.asOf);
    if (!(age <= MAX_CONTEXT_AGE_MS)) {
      log(`--context ${opts.context} is ${Math.round(age / 60_000)} min old (max ${MAX_CONTEXT_AGE_MS / 60_000}): collect again`);
      return { ...result, exitCode: 1 };
    }
    pack = saved.pack as unknown as ContextPack;
    board = saved.board as unknown as Board;
  } else {
    pack = await collect({ env, now, fetch: f, hl: deps.hl, scope: opts.mode === "daily" ? "full" : "scan", openPaths: ledger0.open.map((s) => ({ asset: s.asset, since: s.updated_at })) });
    board = await collectBoard({ ctxs: pack.hl?.ctxs ?? [], always: [...MAJORS, ...myMarkets(env.PLATFORM_MY_MARKETS)], history: history0, now, fetch: f, hl: deps.hl }, pack.gaps);
  }
  result.gaps = pack.gaps;
  const tripwires = evaluateTripwires(board.rows);
  const htf: Record<string, HtfFeatures | null> = {};
  for (const coin of MAJORS) if (pack.daily[coin]) htf[coin] = htfFeatures(pack.daily[coin] ?? [], pack.weekly[coin] ?? []);

  // 3. Settle open setups against the price path. No path (a gap) → untouched, so the next run re-checks it.
  const advanced = ledger0.open.map((s) => {
    const path = pack.path[s.asset];
    if (path) return advanceSetup(s, path, now);
    return now.getTime() >= Date.parse(s.expires_at) ? advanceSetup(s, [], now) : s;
  });
  const statusChanges = advanced.filter((s, i) => s.status !== ledger0.open[i]!.status);
  const ledgerForPrompt: Ledger = { ...ledger0, open: advanced.filter((s) => s.status === "watching" || s.status === "triggered") };

  const user = scanUser({ pack, board, tripwires, view, ledger: ledgerForPrompt, prevWatchlist: prev?.watchlist ?? null, mode: opts.mode });
  if (opts.collectOnly) {
    const macro = opts.mode === "daily" ? `\n\n=== macro context (daily) ===\n${numbersBlock(pack, htf)}` : "";
    log(`=== rules (the scan system prompt) ===\n${SCAN_SYSTEM}\n\n=== board and context ===\n${user}${macro}\n\n=== collection ===\n${packSummary(pack, htf, board, tripwires)}`);
    if (opts.context) {
      await writeFile(opts.context, JSON.stringify({ version: 1, pack, board }));
      log(`saved the collection to ${opts.context}`);
    }
    return result;
  }

  // 4. Model, or the external agent's scan.
  const cache = new MemoryLlmCache();
  const maxUsd = Number(env.ROUTINE_MAX_USD) > 0 ? Number(env.ROUTINE_MAX_USD) : DEFAULT_MAX_USD;
  const chainDeps = { entries: chain.entries, makeProvider, cache, maxUsd, now: deps.now };
  const attempts: ChainAttempt[] = [];
  let scan: ChainResult<ScanOutput>;
  if (external) {
    const parsed = ScanOutputSchema.safeParse(opts.input);
    scan = parsed.success
      ? { ok: true, value: parsed.data, model: "input", attempts: [] }
      : { ok: false, error: `--input is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, attempts: [] };
  } else {
    scan = await callChain(chainDeps, { system: SCAN_SYSTEM, user, schema: ScanOutputSchema, jsonSchema: toJsonSchema(ScanOutputSchema), promptVersion: SCAN_PROMPT_VERSION });
  }
  attempts.push(...scan.attempts);

  // 5. Cancels, level resolution, gate, watchlist check.
  const open = advanced;
  const cancelled: Setup[] = [];
  let accepted: Setup[] = [];
  let watchlist: WatchItem[] = [];
  let missed: string[] = [];
  const rows = new Map(board.rows.map((r) => [r.coin, r]));
  if (scan.ok) {
    for (const c of scan.value.cancel) {
      const i = open.findIndex((s) => s.id === c.id && (s.status === "watching" || s.status === "triggered"));
      if (i < 0) {
        notes.push(`cancel ignored: no open setup ${c.id}`);
        continue;
      }
      open[i] = cancelSetup(open[i]!, c.reason, pack.marks[open[i]!.asset] ?? null, now);
      cancelled.push(open[i]!);
    }
    // Every number the model was shown, for the number check on its text.
    const shown = payloadNumbers(`${SCAN_SYSTEM}\n${user}`);
    const proposals: GateProposal[] = [];
    for (const d of scan.value.setups) {
      const r = resolveDraft(d, rows.get(d.asset), now, shown);
      if (r.ok) {
        proposals.push(r.proposal);
        notes.push(...r.notes);
      } else result.rejected.push({ asset: r.asset, direction: r.direction, rule: r.rule, detail: r.detail });
    }
    const stillOpen = open.filter((s) => s.status === "watching" || s.status === "triggered");
    const usedIds = new Set([...ledger0.open, ...ledger0.closed].map((s) => s.id));
    const gated = gateProposals(proposals, { mode: opts.mode, now, marks: new Map(Object.entries(pack.marks)), open: stillOpen, usedIds, htf: view });
    accepted = gated.accepted;
    result.rejected.push(...gated.rejected);
    const checked = checkWatchlist(scan.value.watchlist, rows, shown);
    watchlist = checked.kept;
    for (const d of checked.dropped) notes.push(`watchlist dropped ${d}`);
    missed = unanswered(tripwires.hits, scan.value);
  } else {
    notes.push(`model call failed: ${scan.error}`);
    result.exitCode = 1;
  }
  const ledger = settleLedger([...open, ...accepted], ledger0.closed, now);

  // 6. Files. The ledger is rewritten only when something besides the check timestamps moved; the board history
  // takes a snapshot every run (it is what OI deltas are measured against), unless Hyperliquid was unreachable.
  const files: Array<{ path: string; text: string }> = [];
  if (rawLedger === null || stripTimes(ledger) !== stripTimes(ledger0)) files.push({ path: join(setupsDir, "ledger.json"), text: jsonText(ledger) });
  const boardCoins = new Set(board.rows.map((r) => r.coin));
  if (board.rows.length)
    files.push({ path: join(boardDir, "history.json"), text: jsonText(appendSnapshot(history0, (pack.hl?.ctxs ?? []).filter((c) => boardCoins.has(c.name)), new Date(board.asOf))) });
  const prevHits = new Set((prev?.hits ?? []).map(tripwireKey));
  const newHits = tripwires.hits.filter((t) => !prevHits.has(tripwireKey(t)));
  const prevWatch = new Set((prev?.watchlist ?? []).map(watchKey));
  if (scan.ok) {
    const record: ScanRecord = {
      generated_at: nowIso,
      read: scan.value.read,
      watchlist,
      hits: tripwires.hits.map(({ asset, setup_id, direction }) => ({ asset, setup_id, direction })),
      near: tripwires.near.map(({ asset, setup_id, direction, gap }) => ({ asset, setup_id, direction, gap })),
      new_setups: accepted.map((s) => s.id),
      rejected: result.rejected,
      passes: scan.value.passes,
      unanswered: missed,
      brief: scan.value.brief,
    };
    files.push({ path: join(boardDir, "latest.json"), text: jsonText(record) });
  }
  let dailyOk = false;
  let scorecard: string[] = [];
  if (opts.mode === "daily") {
    // A throw here (bad index file, schema miss) must not cost the scan outputs computed above.
    try {
      const daily = await runDaily({ opts, env, pack, htf, view, date, nowIso, chainDeps, scanBrief: scan.ok ? scan.value.brief : null, notes });
      attempts.push(...daily.attempts);
      if (daily.files) {
        files.push(...daily.files);
        scorecard = daily.scorecard;
        dailyOk = true;
      } else result.exitCode = 1;
    } catch (e) {
      notes.push(`daily MarketState/Sectors not written: ${e instanceof Error ? e.message : String(e)}`);
      result.exitCode = 1;
    }
  }

  // 7. Brief.
  const btc = rows.get("BTC");
  const head = `hypertrade scan · ${opts.mode}${opts.dryRun ? " (dry run)" : ""} · ${nowIso.slice(0, 16)}Z · ${board.rows.length} markets${btc ? ` · BTC 1w ${btc.tf["1w"]?.trend ?? "n/a"} / 1d ${btc.tf["1d"]?.trend ?? "n/a"}` : ""}${pack.hlCycles?.regime ? ` · hl-cycles ${pack.hlCycles.regime.state}` : ""}${view ? ` · stance ${view.stance}` : ""}`;
  const body: string[] = [head];
  if (scan.ok) body.push("", `Read: ${scan.value.read}`, "", scan.value.brief);
  body.push("", "Setups (conditional plans, not orders):");
  for (const s of accepted) body.push(`- NEW ${fmtSetup(s)}`);
  for (const s of statusChanges) body.push(`- ${s.id} → ${s.status}${s.r_result !== null ? ` (${s.r_result}R)` : ""} — ${s.status_note}`);
  for (const s of cancelled) body.push(`- Cancelled ${s.id} — ${s.status_note}${s.r_result !== null ? ` (${s.r_result}R)` : ""}`);
  for (const s of ledger.open.filter((x) => !accepted.includes(x))) {
    const mark = pack.marks[s.asset];
    body.push(`- Open ${s.id} ${s.status}${mark ? ` — mark ${mark}, ${pctFrom(mark, entryMid(s))}% from entry mid, invalidation ${s.invalidation}` : ""}`);
  }
  for (const r of result.rejected) body.push(`- Dropped: ${r.asset} ${r.direction} — ${r.rule} (${r.detail})`);
  if (scan.ok && !scan.value.setups.length) body.push("- No plan proposed this run.");
  if (watchlist.length) body.push("", "Watch:", ...watchlist.map((w) => `- ${prevWatch.has(watchKey(w)) ? "" : "NEW "}${w.asset} ${w.kind} (${w.timeframe}, skew ${w.skew}) — ${w.note} · arms: ${w.arms}`));
  body.push("", `Tripwires: ${tripwires.hits.length} hit${tripwires.hits.length === 1 ? "" : "s"}, ${tripwires.near.length} near`);
  for (const t of tripwires.hits) body.push(`- ${prevHits.has(tripwireKey(t)) ? "" : "NEW "}hit ${formatTripwire(t)}`);
  for (const t of tripwires.near.slice(0, 3)) body.push(`- near ${formatTripwire(t)}`);
  if (scan.ok && scan.value.passes.length) body.push("", "Passed:", ...scan.value.passes.map((p) => `- ${p.asset} ${p.template} ${p.direction} — ${p.reason}`));
  if (missed.length) body.push(`Not addressed by the scan: ${missed.join(", ")}`);
  if (scorecard.length) body.push("", "Scorecard (last daily run):", ...scorecard);
  if (dailyOk) body.push("", `MarketState + Sectors written for ${date}.`);
  if (notes.length) body.push("", ...notes.map((n) => `Note: ${n}`));
  if (pack.gaps.length) body.push("", `Data gaps: ${pack.gaps.map((g) => `${g.source} (${g.status})`).join(", ")}`);
  body.push("", `Stats 90d: ${ledger.stats.closed_90d} closed, ${ledger.stats.triggered_90d} triggered, hit rate ${ledger.stats.hit_rate ?? "n/a"}, avg ${ledger.stats.avg_r ?? "n/a"}R · ${ledger.open.length} open`);
  body.push("Market intelligence, not financial advice.");
  result.brief = body.join("\n");
  log(result.brief);
  log(`llm: ${attempts.map((a) => `${a.entry} ${a.ok ? "ok" : `failed (${a.error})`} ${Math.round(a.ms / 1000)}s ${a.usage.input_tokens}/${a.usage.output_tokens} tok`).join("; ") || "no calls"} · est. $${cache.spentUsd().toFixed(2)} of $${maxUsd.toFixed(2)}`);

  // 8. Push: only something new, once (new setup, status change, cancel, a tripwire hit the last run did not have, a daily write).
  if (accepted.length || statusChanges.length || cancelled.length || newHits.length || dailyOk) {
    const lines = [head];
    if (scan.ok) lines.push(`Read: ${scan.value.read}`);
    for (const s of accepted) lines.push(`NEW ${s.asset} ${s.direction} ${s.timeframe ?? ""} · entry ${s.entry.low}–${s.entry.high} · inv ${s.invalidation} · ${s.rr}R · ${s.conviction}`);
    for (const s of statusChanges) lines.push(`${s.id} → ${s.status}${s.r_result !== null ? ` (${s.r_result}R)` : ""}`);
    for (const s of cancelled) lines.push(`Cancelled ${s.id}`);
    for (const t of newHits) lines.push(`Tripwire: ${t.asset} ${t.setup_id} ${t.direction}`);
    result.push = [...lines.slice(0, 7), "Conditional plans and facts, not advice."].join("\n");
  }

  // 9. Write.
  if (opts.dryRun) {
    for (const file of files) log(`--- would write ${file.path}\n${file.text}`);
  } else {
    for (const file of files) {
      await mkdir(join(file.path, ".."), { recursive: true });
      await writeFile(file.path, file.text);
      result.wrote.push(file.path);
    }
    if (opts.pushOut) await writeFile(opts.pushOut, result.push ?? "");
  }

  // 10. Step summary and notification.
  if (env.GITHUB_STEP_SUMMARY && !opts.dryRun) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `## Routine ${opts.mode}\n\n\`\`\`\n${result.brief}\n\`\`\`\n`).catch((e) => log(`step summary: ${e instanceof Error ? e.message : String(e)}`));
  }
  if (result.push && !opts.dryRun && !opts.pushOut) result.notified = await notifyTelegram(env, result.brief, f, log);
  else log(`push: ${opts.dryRun ? "dry run, nothing sent" : !result.push ? "nothing new, no notification" : `written to ${opts.pushOut}`}`);
  return result;
}

async function runDaily(a: {
  opts: RunOptions;
  env: RunDeps["env"];
  pack: ContextPack;
  htf: Record<string, HtfFeatures | null>;
  view: HtfView | null;
  date: string;
  nowIso: string;
  chainDeps: Parameters<typeof callChain>[0];
  scanBrief: string | null;
  notes: string[];
}): Promise<{ files: Array<{ path: string; text: string }> | null; scorecard: string[]; attempts: ChainAttempt[] }> {
  const dataDir = join(a.opts.root, "data");
  const msDir = join(dataDir, "marketstate");
  const secDir = join(dataDir, "sectors");
  const labDir = join(dataDir, "lab");
  const prevMsPath = await latestDated(msDir, a.date);
  const prevSecPath = await latestDated(secDir, a.date);
  const prevMs = prevMsPath ? await readJson(prevMsPath) : null;
  const prevSec = prevSecPath ? await readJson(prevSecPath) : null;

  const res = await callChain(a.chainDeps, {
    system: DAILY_SYSTEM,
    user: dailyUser({ pack: a.pack, htf: a.htf, view: a.view, prevMarketState: prevMs, prevSectors: prevSec, runDate: a.date, scanBrief: a.scanBrief }),
    schema: DailyOutputSchema,
    jsonSchema: toJsonSchema(DailyOutputSchema),
    promptVersion: DAILY_PROMPT_VERSION,
  });
  if (!res.ok) {
    a.notes.push(`daily MarketState/Sectors not written: ${res.error}`);
    return { files: null, scorecard: [], attempts: res.attempts };
  }
  const out = res.value;
  const live = new Set(Object.keys(a.pack.marks));
  const sectors = out.sectors.sectors.map((s) => {
    // ROUTINE.md: only symbols listed on Hyperliquid. Without a live universe (HL gap) nothing can be checked, so keep them.
    if (!live.size) return s;
    const dropped = s.tokens.filter((t) => !live.has(t));
    if (dropped.length) a.notes.push(`sector ${s.id}: dropped symbols not on Hyperliquid: ${dropped.join(", ")}`);
    return { ...s, tokens: s.tokens.filter((t) => live.has(t)) };
  });
  const marketstate = MarketStateDataSchema.parse({ generated_at: a.nowIso, ...out.marketstate, thesis: { ...out.marketstate.thesis, disclaimer: DISCLAIMER } });
  const sectorsData = SectorsDataSchema.parse({ generated_at: a.nowIso, sectors, rotations: out.sectors.rotations });

  const files: Array<{ path: string; text: string }> = [];
  const msText = jsonText(marketstate);
  const secText = jsonText(sectorsData);
  files.push({ path: join(msDir, "latest.json"), text: msText }, { path: join(msDir, `${a.date}.json`), text: msText });
  files.push({ path: join(secDir, "latest.json"), text: secText }, { path: join(secDir, `${a.date}.json`), text: secText });
  for (const dir of [msDir, secDir]) {
    const path = join(dir, "index.ts");
    const before = await readFile(path, "utf8");
    const after = registerDate(before, a.date);
    if (after !== before) files.push({ path, text: after });
  }
  files.push({ path: join(labDir, `${a.date}.json`), text: jsonText(await labSnapshot(labDir, a.pack, a.nowIso, a.date, a.env)) });
  return { files, scorecard: out.scorecard.map((s) => `- ${s.call} → ${s.grade} — ${s.evidence}`), attempts: res.attempts };
}

/** data/lab/<date>.json (ROUTINE.md § Daily). Without a Lab read, the previous snapshot's pulse and ids carry over with a note. */
async function labSnapshot(labDir: string, pack: ContextPack, nowIso: string, date: string, env: RunDeps["env"]) {
  const hl_cycles = { regime_state: pack.hlCycles?.regime?.state ?? null, as_of: pack.hlCycles?.asOf ?? null };
  const pulse = pack.lab?.pulse;
  const catalogue = pack.lab?.catalogue;
  if (pulse && catalogue) {
    const snap: Record<string, { firing: boolean; asset: string; direction: string }> = {};
    for (const asset of pulse.assets) for (const rule of asset.rules) snap[rule.id] = { firing: rule.firing, asset: asset.asset, direction: rule.direction };
    return { generated_at: nowIso, pulse: snap, catalogue_ids: catalogue, hl_cycles };
  }
  const prevPath = await latestDated(labDir, date);
  const prev = ((prevPath ? await readJson(prevPath) : null) ?? {}) as { pulse?: unknown; catalogue_ids?: unknown };
  const why = !env.LAB_API_TOKEN?.trim() ? "LAB_API_TOKEN not set" : !env.APP_URL?.trim() ? "APP_URL not set" : pack.gaps.filter((g) => g.source.startsWith("lab.")).map((g) => `${g.source} ${g.status}`).join(", ") || "lab read failed";
  return { generated_at: nowIso, pulse: prev.pulse ?? {}, catalogue_ids: prev.catalogue_ids ?? [], hl_cycles, note: `lab skipped: ${why}` };
}
