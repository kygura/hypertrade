// bun run routine [--mode <scan|daily>] [--dry-run] [--collect-only] [--context <file>] [--input <file>] [--push-out <file>]
// --collect-only: print the scan prompt (rules + board) and, with --context, save the collection there.
// --input: a scan output JSON from an external agent stands in for the model call; with --context it resolves
// against the saved board instead of collecting again. --push-out: write the push text there instead of sending it.
// The routine pipeline (docs/fallback-routine.md). Run by ROUTINE.md or by hand; writes data/setups and data/board
// (and, in daily mode, data/marketstate, data/sectors, data/lab) under the current directory.
import { readFile } from "node:fs/promises";
import { runRoutine, type Mode } from "../src/server/routine/run.js";

const USAGE = "usage: bun run routine [--mode <scan|daily>] [--dry-run] [--collect-only] [--context <file>] [--input <file>] [--push-out <file>]";
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const value = (name: string) => (flag(name) ? argv[argv.indexOf(name) + 1] : undefined);
const modeArg = value("--mode");
const mode: Mode | null = flag("--mode") ? (["scan", "daily"].includes(modeArg ?? "") ? (modeArg as Mode) : null) : "scan";
if (!mode) {
  console.error(USAGE);
  process.exit(2);
}
for (const name of ["--input", "--context", "--push-out"])
  if (flag(name) && !value(name)?.trim()) {
    console.error(`${name} needs a file path\n${USAGE}`);
    process.exit(2);
  }

try {
  const inputPath = value("--input");
  const input = inputPath ? JSON.parse(await readFile(inputPath, "utf8")) : undefined;
  const result = await runRoutine(
    { mode, dryRun: flag("--dry-run"), collectOnly: flag("--collect-only"), input, context: value("--context"), pushOut: value("--push-out"), root: process.cwd() },
    { env: process.env, now: () => new Date(), log: (line) => console.log(line) },
  );
  process.exit(result.exitCode);
} catch (err) {
  console.error(`routine: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
