// bun run eval <command> [--flags]   (docs/EVAL.md; the agent loop is in docs/eval/program.md)
//   snapshot  --out f.json                         panels for BTC, ETH, HYPE from the Lab registry (stored, then live)
//   search    [--data f.json] [--assets BTC,ETH,HYPE] [--families trend,...] [--max 600] [--budget 60] [--seed 1]
//             [--dir .eval/run]                    built-in mutator; writes results.tsv and best.json, prints search
//                                                  scores only (the holdout is read once, by finalize)
//   try       --spec '{...}' | --spec-file f.json [--data f.json] [--dir .eval/run] [--description "..."]
//             one experiment (an agent's proposal): scores it, keeps it in best.json if it beats the family's best,
//             appends a row to results.tsv either way, prints the row
//   finalize  [--data f.json] [--dir .eval/run]    holdout + deflated Sharpe for best.json
//   paths     [--data f.json] [--asset BTC] [--horizon 60] [--n 5000] [--levels 58500,66000] [--races 58500:66000]
//   calibrate [--data f.json] [--asset BTC] [--horizon 30]
//   report    [--data f.json] [--dir .eval/run] [--out .eval/report.html] [--horizon 60] [--levels BTC=58500,66000;ETH=...]
// Without --data, panels load from the Lab registry (DATABASE_URL history, else live). Output dirs are git-ignored.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPanels, panelsFromSnapshot, snapshotOf } from "../src/server/eval/load.js";
import { EVAL_ASSETS, type EvalPanel } from "../src/server/eval/panel.js";
import { calibrate, simulatePaths } from "../src/server/eval/paths.js";
import { renderReport } from "../src/server/eval/report.js";
import { avg as avgMetric, contextOf, finalize, runSearch, scoreSpec, TSV_HEADER, tsvRow, type Experiment, type Scored, type SearchResult } from "../src/server/eval/search.js";
import { FAMILIES, type Family, type StrategySpec } from "../src/server/eval/strategies.js";

function parse(argv: string[]): { cmd: string; f: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const f: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) f[a.slice(2)] = "true";
    else {
      f[a.slice(2)] = next;
      i++;
    }
  }
  return { cmd, f };
}

const list = (s: string | undefined, d: readonly string[]) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [...d]);
const nums = (s: string | undefined) => (s ? s.split(",").map(Number).filter(Number.isFinite) : undefined);

async function panelsOf(f: Record<string, string>): Promise<EvalPanel[]> {
  const assets = list(f.assets ?? f.asset, EVAL_ASSETS).map((a) => a.toUpperCase());
  if (f.data) return panelsFromSnapshot(JSON.parse(readFileSync(f.data, "utf8")), assets);
  const { panels, warnings } = await loadPanels(assets);
  for (const w of warnings) console.error(`[eval] ${w}`);
  return panels;
}

function ensureDir(d: string) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

type BestFile = { assets: string[]; best: Partial<Record<Family, Scored>>; trials: number };

function readBest(dir: string): BestFile | null {
  const p = join(dir, "best.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as BestFile) : null;
}

function appendTsv(dir: string, rows: Experiment[]) {
  const p = join(dir, "results.tsv");
  if (!existsSync(p)) writeFileSync(p, `${TSV_HEADER}\n`);
  appendFileSync(p, rows.map((r) => `${tsvRow(r)}\n`).join(""));
}

async function main() {
  const { cmd, f } = parse(process.argv.slice(2));
  const dir = f.dir ?? ".eval/run";
  switch (cmd) {
    case "snapshot": {
      const panels = await panelsOf(f);
      const out = f.out ?? ".eval/snapshot.json";
      ensureDir(dirname(out));
      writeFileSync(out, JSON.stringify(snapshotOf(panels)));
      console.log(JSON.stringify({ out, assets: panels.map((p) => ({ asset: p.asset, days: p.t.length, iv: p.ivSource, sth: p.sthSource })) }));
      return;
    }
    case "search": {
      const panels = await panelsOf(f);
      const ctxs = panels.map((p) => contextOf(p));
      ensureDir(dir);
      const prior = readBest(dir);
      const families = list(f.families, FAMILIES) as Family[];
      const start: Partial<Record<Family, StrategySpec>> = {};
      for (const fam of families) if (prior?.best[fam]) start[fam] = prior.best[fam]!.spec;
      const res = runSearch(ctxs, {
        families,
        seed: Number(f.seed ?? 1),
        maxExperiments: Number(f.max ?? 600),
        budgetMs: f.budget ? Number(f.budget) * 1000 : undefined,
        start,
        firstN: prior?.trials ?? 0,
      });
      appendTsv(dir, res.log);
      const merged = { ...(prior?.best ?? {}) };
      for (const [fam, s] of Object.entries(res.best) as Array<[Family, Scored]>) if (!merged[fam] || s.score > merged[fam]!.score) merged[fam] = s;
      const best: BestFile = { assets: panels.map((p) => p.asset), best: merged, trials: (prior?.trials ?? 0) + res.trials };
      writeFileSync(join(dir, "best.json"), JSON.stringify(best, null, 1));
      for (const s of Object.values(merged)) if (s) console.log(`${s.score.toFixed(3)}\t${s.key}`);
      return;
    }
    case "try": {
      const spec = JSON.parse(f.spec ?? readFileSync(f["spec-file"]!, "utf8")) as StrategySpec;
      if (!(FAMILIES as readonly string[]).includes(spec.family)) throw new Error(`unknown family ${spec.family}`);
      const panels = await panelsOf(f);
      const ctxs = panels.map((p) => contextOf(p));
      ensureDir(dir);
      const prior = readBest(dir) ?? { assets: panels.map((p) => p.asset), best: {}, trials: 0 };
      const cur = prior.best[spec.family] ?? null;
      const s = scoreSpec(spec, ctxs);
      const status = cur === null ? "baseline" : s.score > cur.score ? "keep" : "discard";
      if (status !== "discard") prior.best[spec.family] = s;
      const row0 = prior.trials;
      prior.trials++;
      writeFileSync(join(dir, "best.json"), JSON.stringify(prior, null, 1));
      const avg = (k: "sharpe" | "maxDD" | "cvar95" | "ivCarry") => avgMetric(s, k);
      const row: Experiment = { n: row0, family: spec.family, key: s.key, score: s.score, sharpe: avg("sharpe"), maxDD: avg("maxDD"), cvar95: avg("cvar95"), ivCarry: avg("ivCarry"), status, description: f.description ?? "agent proposal" };
      appendTsv(dir, [row]);
      console.log(TSV_HEADER);
      console.log(tsvRow(row));
      console.log(`best ${spec.family}: ${prior.best[spec.family]!.score.toFixed(4)}`);
      return;
    }
    case "finalize": {
      const panels = await panelsOf(f);
      const ctxs = panels.map((p) => contextOf(p));
      const prior = readBest(dir);
      if (!prior) throw new Error(`no ${join(dir, "best.json")}`);
      const res: SearchResult = { best: prior.best, log: [], trials: prior.trials };
      const fin = finalize(res, ctxs);
      writeFileSync(join(dir, "finalists.json"), JSON.stringify(fin, null, 1));
      console.log(JSON.stringify(fin.map((x) => ({ key: x.key, search: x.searchScore, holdout: x.holdoutScore, now: x.now, perAsset: Object.fromEntries(Object.entries(x.holdout).map(([a, h]) => [a, { sharpe: h.sharpe, maxDD: h.maxDD, cagr: h.cagr, exposure: h.exposure, dsr: h.deflatedSharpe }])) })), null, 1));
      return;
    }
    case "paths": {
      const [panel] = await panelsOf({ ...f, assets: f.asset ?? "BTC" });
      const races = f.races?.split(",").map((r) => r.split(":").map(Number) as [number, number]);
      const r = simulatePaths(panel!, { horizon: Number(f.horizon ?? 60), n: Number(f.n ?? 5000), levels: nums(f.levels), races, keepPaths: 0 });
      console.log(JSON.stringify({ ...r, bands: r.bands.filter((b) => b.day % 5 === 0 || b.day === r.horizon), paths: undefined }, null, 1));
      return;
    }
    case "calibrate": {
      const panels = await panelsOf({ ...f, assets: f.asset ?? f.assets ?? "BTC,ETH,HYPE" });
      for (const p of panels) console.log(JSON.stringify(calibrate(p, { horizon: Number(f.horizon ?? 30) })));
      return;
    }
    case "report": {
      const panels = await panelsOf(f);
      const lv: Record<string, number[]> = {};
      for (const part of (f.levels ?? "").split(";").filter(Boolean)) {
        const [a, xs] = part.split("=");
        lv[a!.toUpperCase()] = nums(xs) ?? [];
      }
      const horizon = Number(f.horizon ?? 60);
      const paths = panels.map((p) => simulatePaths(p, { horizon, levels: lv[p.asset], keepPaths: 12 }));
      const calibration = f.calibrate === "false" ? undefined : panels.map((p) => calibrate(p, { horizon: 30 }));
      const fin = existsSync(join(dir, "finalists.json")) ? JSON.parse(readFileSync(join(dir, "finalists.json"), "utf8")) : undefined;
      const out = f.out ?? ".eval/report.html";
      ensureDir(dirname(out));
      const notes = panels.map((p) => `${p.asset}: implied vol from ${p.ivSource === "realized" ? "realized vol × the BTC variance premium (no options market)" : p.ivSource === "mixed" ? "DVOL, realized-vol stand-in before DVOL existed" : "DVOL"}; STH cost basis from ${p.sthSource === "proxy" ? "the 155-day mean stand-in" : p.sthSource === "mixed" ? "stored values, 155-day stand-in elsewhere" : "stored values"}.`);
      writeFileSync(out, renderReport({ generated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", paths, calibration, finalists: fin, trials: readBest(dir)?.trials, notes }));
      console.log(out);
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
