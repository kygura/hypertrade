// bun run autoresearch prepare --asset BTC [--from 2017-01-01] [--price cm:PriceUSD]
// bun run autoresearch metrics --asset BTC
// bun run autoresearch eval --domain onchain --desc "why" --rule '{...}'      (or --file rule.json)
// bun run autoresearch board [--asset BTC]
// bun run autoresearch report --asset BTC [--horizon 30]
// Files live in AUTORESEARCH_DIR (default ./.autoresearch, untracked): <ASSET>.json (the pinned dataset) and results.tsv.
// The method is docs/AUTORESEARCH.md; the evaluator is src/server/lab/autoresearch.ts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { champions, decide, finalReport, parseTsv, rowOf, runExperiment, slotOf, toTsv, TSV_HEADER, type Row } from "../src/server/lab/autoresearch.js";
import { RuleSchema, type LabDataset } from "../src/server/lab/types.js";

const DIR = process.env.AUTORESEARCH_DIR ?? ".autoresearch";
const TSV = join(DIR, "results.tsv");

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith("--")) out[argv[i]!.slice(2)] = argv[++i] ?? "";
  return out;
}

const dataPath = (asset: string) => join(DIR, `${asset.toUpperCase()}.json`);

type Pinned = { dataset: LabDataset; metrics: Array<{ id: string; category: string; name: string; from: string | null; days: number }>; preparedAt: string };

function loadPinned(asset: string): Pinned {
  if (!existsSync(dataPath(asset))) throw new Error(`no pinned dataset for ${asset}: run \`bun run autoresearch prepare --asset ${asset}\` first`);
  const p = JSON.parse(readFileSync(dataPath(asset), "utf8")) as Pinned;
  // JSON stored NaN as null.
  for (const k of Object.keys(p.dataset.metrics)) p.dataset.metrics[k] = p.dataset.metrics[k]!.map((x) => x ?? NaN);
  return p;
}

const rows = (): Row[] => (existsSync(TSV) ? parseTsv(readFileSync(TSV, "utf8")) : []);

async function prepare(a: Record<string, string>) {
  process.env.LAB_LOCAL = "1";
  const { allMetrics, loadDataset, PROVIDERS } = await import("../src/server/lab/providers/registry.js");
  const asset = a.asset!;
  const defs = allMetrics({ asset }, PROVIDERS);
  const { dataset, warnings } = await loadDataset({ asset, metrics: defs.map((d) => d.id), price: a.price ?? "cm:PriceUSD", from: a.from ?? "2017-01-01" });
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const metrics = defs
    .filter((d) => dataset.metrics[d.id])
    .map((d) => {
      const v = dataset.metrics[d.id]!;
      const first = v.findIndex((x) => Number.isFinite(x));
      return { id: d.id, category: d.category, name: d.name, from: first < 0 ? null : iso(dataset.t[first]!), days: v.filter((x) => Number.isFinite(x)).length };
    })
    .filter((m) => m.days > 0);
  for (const id of Object.keys(dataset.metrics)) if (!metrics.some((m) => m.id === id)) delete dataset.metrics[id];
  mkdirSync(DIR, { recursive: true });
  const pinned: Pinned = { dataset, metrics, preparedAt: new Date().toISOString() };
  writeFileSync(dataPath(asset), JSON.stringify(pinned));
  if (!existsSync(TSV)) writeFileSync(TSV, TSV_HEADER.join("\t") + "\n");
  return { asset, days: dataset.t.length, from: iso(dataset.t[0]!), to: iso(dataset.t.at(-1)!), metrics, warnings };
}

function evaluate(a: Record<string, string>) {
  if (!a.domain) throw new Error("--domain is required (the slot the candidate competes in)");
  const rule = RuleSchema.parse(JSON.parse(a.rule ?? readFileSync(a.file!, "utf8")));
  const exp = runExperiment(rule, loadPinned(rule.asset).dataset);
  const slot = slotOf(rule, a.domain);
  const { status, why } = decide(exp, slot, rows());
  appendFileSync(TSV, toTsv(rowOf(exp, rule, slot, status, a.desc ?? "")) + "\n");
  return { status, why, slot, ...exp };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  let out: unknown;
  if (cmd === "prepare") out = await prepare(a);
  else if (cmd === "metrics") out = loadPinned(a.asset!).metrics;
  else if (cmd === "eval") out = evaluate(a);
  else if (cmd === "board") out = { experiments: rows().length, champions: champions(rows().filter((r) => !a.asset || r.rule.asset.toUpperCase() === a.asset.toUpperCase())).map(({ rule, ...r }) => ({ ...r, rule: JSON.stringify(rule) })) };
  else if (cmd === "report") out = finalReport(a.asset!, rows(), loadPinned(a.asset!).dataset, { horizonDays: a.horizon ? Number(a.horizon) : undefined });
  else throw new Error("usage: autoresearch prepare|metrics|eval|board|report (see the header of scripts/autoresearch.ts)");
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
