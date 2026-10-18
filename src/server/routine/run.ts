import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { telegramApi } from "../desk/notify.js";
import type { AnalystEnv } from "../llm/provider.js";
import { collect, MAJORS, type ContextPack, type HlClient } from "./collect.js";
import { gateProposals, type Rejection } from "./gate.js";
import { htfFeatures, htfRefreshReason, type HtfFeatures, HTF_MAX_AGE_MS } from "./htf.js";
import { advanceSetup, cancelSetup, emptyLedger, settleLedger } from "./ledger.js";
import { anyProviderConfigured, callChain, DEFAULT_MAX_USD, envProviderFactory, MemoryLlmCache, parseChain, type ChainAttempt, type ProviderFactory } from "./llm.js";
import { DAILY_PROMPT_VERSION, DAILY_SYSTEM, dailyUser, PULSE_PROMPT_VERSION, PULSE_SYSTEM, pulseUser } from "./prompts.js";
import {
  DailyOutputSchema,
  DISCLAIMER,
  HtfViewSchema,
  LedgerSchema,
  MarketStateDataSchema,
  pulseOutputSchema,
  SectorsDataSchema,
  toJsonSchema,
  type HtfView,
  type Ledger,
  type Setup,
} from "./schema.js";

// The fallback routine's orchestration (docs/fallback-routine.md § Pipeline
// per run): load state → collect → HTF features → settle open setups against
// prices → model → gate → write → brief → notify. Everything with a side
// effect (fetch, provider, clock, filesystem root, Telegram) comes in through
// RunDeps so a test can drive a whole run against a temp directory.

export type Mode = "pulse" | "daily" | "htf";

export interface RunOptions {
  mode: Mode;
  dryRun: boolean;
  /** Collect and print the context pack summary; no model, no writes. */
  collectOnly?: boolean;
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
  notified: boolean;
  rejected: Rejection[];
  gaps: ContextPack["gaps"];
}

const TELEGRAM_LIMIT = 3900;
const jsonText = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;

/** YYYY-MM-DD in Atlantic/Canary (CLAUDE.md §1: the routine's execution date). */
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

export function packSummary(pack: ContextPack, htf: Record<string, HtfFeatures | null>): string {
  const lines = [`context pack @ ${pack.asOf}`];
  lines.push(`  hyperliquid: ${pack.hl ? `${pack.hl.universeSize} live symbols, kept ${pack.hl.assets.length}` : "missing"}`);
  for (const coin of MAJORS) {
    const h = htf[coin];
    lines.push(
      `  ${coin}: daily ${pack.daily[coin]?.length ?? 0}, weekly ${pack.weekly[coin]?.length ?? 0}` +
        (h ? ` · close ${h.close} · vs20W ${h.vs20wPct}% · vs200D ${h.vs200dPct}% · rv30 ${h.rv30Pct}% · trend ${h.trend}` : " · no features"),
    );
  }
  const c = pack.hlCycles;
  lines.push(`  hl-cycles: ${c ? `${c.regime?.state ?? "?"} since ${c.regime?.since ?? "?"} · ${c.levels.length} levels · compass ${c.compass?.score ?? "?"}${c.stale ? " · STALE" : ""}` : "missing"}`);
  lines.push(`  fred: ${Object.entries(pack.fred).map(([k, v]) => `${k} ${v.at(-1)?.value} (${v.at(-1)?.date})`).join(", ") || "none"}`);
  lines.push(`  yahoo: ${Object.entries(pack.yahoo).map(([k, v]) => `${k} ${v.price}`).join(", ") || "none"}`);
  lines.push(`  fear&greed: ${pack.fng ? `${pack.fng.value} ${pack.fng.label}` : "missing"}`);
  lines.push(`  stablecoins: ${pack.stablecoins ? `$${(pack.stablecoins.nowUsd / 1e9).toFixed(1)}B (7d ${pack.stablecoins.d7Pct}%, 30d ${pack.stablecoins.d30Pct}%)` : "missing"}`);
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
  `${s.id}: ${s.asset} ${s.direction} ${s.horizon}, entry ${s.entry.low}–${s.entry.high}, invalidation ${s.invalidation}, targets ${s.targets.join("/")}, ${s.rr}R, ${s.conviction} conviction${s.regime_alignment === "counter" ? " (counter-regime)" : ""}. Trigger: ${s.trigger}`;

export async function runRoutine(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const { env, log } = deps;
  const f = deps.fetch ?? fetch;
  const now = deps.now();
  const nowIso = now.toISOString();
  const date = runDate(now);
  const dataDir = join(opts.root, "data");
  const setupsDir = join(dataDir, "setups");
  const result: RunResult = { exitCode: 0, wrote: [], brief: "", notified: false, rejected: [], gaps: [] };

  // The workflow names the daily commit after the run's own date, not a second clock read.
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `run_date=${date}\n`).catch((e) => log(`GITHUB_OUTPUT: ${e instanceof Error ? e.message : String(e)}`));

  const chain = parseChain(env.ROUTINE_LLM);
  for (const e of chain.errors) log(`ROUTINE_LLM: ignored ${e}`);
  if (!opts.collectOnly && !chain.entries.length) {
    // A misconfigured chain is an error, unlike a missing key (exit 0 below).
    log(`ROUTINE_LLM has no usable entry: ${chain.errors.join("; ")}`);
    return { ...result, exitCode: 1 };
  }
  const makeProvider = deps.makeProvider ?? envProviderFactory(env as AnalystEnv);
  if (!opts.collectOnly && !anyProviderConfigured(chain.entries, makeProvider)) {
    log(`no LLM provider configured (ROUTINE_LLM=${env.ROUTINE_LLM?.trim() || "default"}; set the key for one of its providers). Nothing to do.`);
    return result;
  }

  // 1. State. A ledger or view that exists but does not parse stops the run: overwriting it would lose history.
  const rawLedger = await readJson(join(setupsDir, "ledger.json"));
  const ledger0: Ledger = rawLedger === null ? emptyLedger(now) : LedgerSchema.parse(rawLedger);
  const rawView = await readJson(join(setupsDir, "htf.json"));
  const view0: HtfView | null = rawView === null ? null : HtfViewSchema.parse(rawView);

  // 2. Collect.
  const pack = await collect({ env, now, fetch: f, hl: deps.hl, openPaths: ledger0.open.map((s) => ({ asset: s.asset, since: s.updated_at })) });
  result.gaps = pack.gaps;
  // 3. HTF features.
  const htf: Record<string, HtfFeatures | null> = {};
  for (const coin of MAJORS) htf[coin] = htfFeatures(pack.daily[coin] ?? [], pack.weekly[coin] ?? []);
  if (opts.collectOnly) {
    log(packSummary(pack, htf));
    return result;
  }

  // 4. Settle open setups against the price path. No path (a gap) → untouched, so the next run re-checks it.
  const advanced = ledger0.open.map((s) => {
    const path = pack.path[s.asset];
    if (path) return advanceSetup(s, path, now);
    return now.getTime() >= Date.parse(s.expires_at) ? advanceSetup(s, [], now) : s;
  });
  const statusChanges = advanced.filter((s, i) => s.status !== ledger0.open[i]!.status);

  // 5. Model.
  const refreshReason = htfRefreshReason(view0, pack.hlCycles?.regime?.state ?? null, now, opts.mode === "htf");
  const cache = new MemoryLlmCache();
  const maxUsd = Number(env.ROUTINE_MAX_USD) > 0 ? Number(env.ROUTINE_MAX_USD) : DEFAULT_MAX_USD;
  const chainDeps = { entries: chain.entries, makeProvider, cache, maxUsd, now: deps.now };
  const attempts: ChainAttempt[] = [];
  const ledgerForPrompt: Ledger = { ...ledger0, open: advanced.filter((s) => s.status === "watching" || s.status === "triggered") };
  const pulseSchema = pulseOutputSchema(refreshReason !== null, opts.mode !== "htf");
  const pulse = await callChain(chainDeps, {
    system: PULSE_SYSTEM,
    user: pulseUser({ pack, htf, view: view0, refreshReason, ledger: ledgerForPrompt, mode: opts.mode }),
    schema: pulseSchema,
    jsonSchema: toJsonSchema(pulseSchema),
    promptVersion: PULSE_PROMPT_VERSION,
  });
  attempts.push(...pulse.attempts);

  // 6. Cancels, new view, gate.
  let open = advanced;
  const cancelled: Setup[] = [];
  const notes: string[] = [];
  let view = view0;
  let regimeChanged = false;
  let accepted: Setup[] = [];
  if (pulse.ok) {
    for (const c of pulse.value.cancel) {
      const i = open.findIndex((s) => s.id === c.id && (s.status === "watching" || s.status === "triggered"));
      if (i < 0) {
        notes.push(`cancel ignored: no open setup ${c.id}`);
        continue;
      }
      open[i] = cancelSetup(open[i]!, c.reason, pack.marks[open[i]!.asset] ?? null, now);
      cancelled.push(open[i]!);
    }
    if (refreshReason && pulse.value.htf_view) {
      view = { ...pulse.value.htf_view, generated_at: nowIso, valid_until: new Date(now.getTime() + HTF_MAX_AGE_MS).toISOString(), hl_cycles_state: pack.hlCycles?.regime?.state ?? null };
      regimeChanged = !view0 || view0.regime !== view.regime || view0.hl_cycles_state !== view.hl_cycles_state;
    }
    if (opts.mode === "htf") {
      // htf mode refreshes the view only; the prompt asks for no setups, and any that come back are not gated.
      if (pulse.value.new_setups.length) notes.push(`htf mode: ignored ${pulse.value.new_setups.length} proposed setup(s)`);
    } else {
      const stillOpen = open.filter((s) => s.status === "watching" || s.status === "triggered");
      const usedIds = new Set([...ledger0.open, ...ledger0.closed].map((s) => s.id));
      const gated = gateProposals(pulse.value.new_setups, { mode: opts.mode, now, marks: new Map(Object.entries(pack.marks)), open: stillOpen, usedIds, htf: view });
      accepted = gated.accepted;
      result.rejected = gated.rejected;
    }
  } else {
    notes.push(`model call failed: ${pulse.error}`);
    result.exitCode = 1;
  }
  const ledger = settleLedger([...open, ...accepted], ledger0.closed, now);

  // 7. Files. The ledger is rewritten only when something besides the check timestamps moved: re-checking an
  // unchanged setup against the same candles gives the same answer, so a quiet pulse leaves no commit behind.
  const files: Array<{ path: string; text: string }> = [];
  if (rawLedger === null || stripTimes(ledger) !== stripTimes(ledger0)) files.push({ path: join(setupsDir, "ledger.json"), text: jsonText(ledger) });
  if (view && view !== view0) files.push({ path: join(setupsDir, "htf.json"), text: jsonText(view) });
  let dailyOk = false;
  let scorecard: string[] = [];
  if (opts.mode === "daily") {
    // A throw here (bad index file, schema miss) must not cost the pulse outputs computed above.
    try {
      const daily = await runDaily({ opts, env, pack, htf, view, date, nowIso, chainDeps, pulseBrief: pulse.ok ? pulse.value.brief : null, notes });
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

  // 8. Brief.
  const head = `hypertrade setups · ${opts.mode}${opts.dryRun ? " (dry run)" : ""} · ${nowIso.slice(0, 16)}Z · HTF ${view ? `${view.regime}/${view.stance}` : "none"}${pack.hlCycles?.regime ? ` · hl-cycles ${pack.hlCycles.regime.state}` : ""}`;
  const body: string[] = [head];
  if (pulse.ok) body.push("", pulse.value.regime_read, "", pulse.value.brief);
  if (refreshReason && view !== view0 && view) body.push("", `HTF view refreshed (${refreshReason}): ${view.thesis}`);
  if (statusChanges.length) body.push("", "Status changes:", ...statusChanges.map((s) => `- ${s.id}: ${s.status}${s.r_result !== null ? ` (${s.r_result}R)` : ""} — ${s.status_note}`));
  if (cancelled.length) body.push("", "Cancelled:", ...cancelled.map((s) => `- ${s.id}: ${s.status_note}${s.r_result !== null ? ` (${s.r_result}R)` : ""}`));
  if (accepted.length) body.push("", "New setups (conditional plans, not orders):", ...accepted.map((s) => `- ${fmtSetup(s)}`));
  else if (pulse.ok && opts.mode !== "htf") body.push("", `No new setups: ${pulse.value.stand_aside_reason ?? "none passed the gate"}`);
  if (result.rejected.length) body.push("", "Dropped by the gate:", ...result.rejected.map((r) => `- ${r.asset} ${r.direction}: ${r.rule} (${r.detail})`));
  if (scorecard.length) body.push("", "Scorecard (last daily run):", ...scorecard);
  if (dailyOk) body.push("", `MarketState + Sectors written for ${date}.`);
  if (notes.length) body.push("", ...notes.map((n) => `Note: ${n}`));
  if (pack.gaps.length) body.push("", `Data gaps: ${pack.gaps.map((g) => `${g.source} (${g.status})`).join(", ")}`);
  body.push("", `Stats 90d: ${ledger.stats.closed_90d} closed, ${ledger.stats.triggered_90d} triggered, hit rate ${ledger.stats.hit_rate ?? "n/a"}, avg ${ledger.stats.avg_r ?? "n/a"}R · ${ledger.open.length} open`);
  body.push("Market intelligence, not financial advice.");
  result.brief = body.join("\n");
  log(result.brief);
  log(`llm: ${attempts.map((a) => `${a.entry} ${a.ok ? "ok" : `failed (${a.error})`} ${Math.round(a.ms / 1000)}s ${a.usage.input_tokens}/${a.usage.output_tokens} tok`).join("; ") || "no calls"} · est. $${cache.spentUsd().toFixed(2)} of $${maxUsd.toFixed(2)}`);

  // 9. Write.
  if (opts.dryRun) {
    for (const file of files) log(`--- would write ${file.path}\n${file.text}`);
  } else {
    for (const file of files) {
      await mkdir(join(file.path, ".."), { recursive: true });
      await writeFile(file.path, file.text);
      result.wrote.push(file.path);
    }
  }

  // 10. Step summary and notification.
  if (env.GITHUB_STEP_SUMMARY && !opts.dryRun) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `## Routine ${opts.mode}\n\n\`\`\`\n${result.brief}\n\`\`\`\n`).catch((e) => log(`step summary: ${e instanceof Error ? e.message : String(e)}`));
  }
  const worthNotifying = statusChanges.length > 0 || cancelled.length > 0 || accepted.length > 0 || regimeChanged || dailyOk;
  if (worthNotifying && !opts.dryRun) result.notified = await notifyTelegram(env, result.brief, f, log);
  else log(`telegram: ${opts.dryRun ? "dry run, nothing sent" : "nothing changed, no notification"}`);
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
  pulseBrief: string | null;
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
    user: dailyUser({ pack: a.pack, htf: a.htf, view: a.view, prevMarketState: prevMs, prevSectors: prevSec, runDate: a.date, pulseBrief: a.pulseBrief }),
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
    // ROUTINE.md §e: only symbols listed on Hyperliquid. Without a live universe (HL gap) nothing can be checked, so keep them.
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

/** data/lab/<date>.json (CLAUDE.md §4.2). Without a Lab read, the previous snapshot's pulse and ids carry over with a note. */
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
