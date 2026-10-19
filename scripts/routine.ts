// bun run routine --mode <pulse|daily|htf> [--dry-run] [--collect-only] [--input <file>]
// --input: a pulse/htf proposal JSON from an external agent stands in for the model call.
// The provider-agnostic fallback routine (docs/fallback-routine.md). Runs from
// .github/workflows/routine.yml; writes data/setups (and, in daily mode,
// data/marketstate, data/sectors, data/lab) under the current directory.
import { readFile } from "node:fs/promises";
import { runRoutine, type Mode } from "../src/server/routine/run.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const modeArg = argv[argv.indexOf("--mode") + 1];
const mode: Mode | null = argv.includes("--mode") ? (["pulse", "daily", "htf"].includes(modeArg ?? "") ? (modeArg as Mode) : null) : "pulse";
if (!mode) {
  console.error("usage: bun run routine --mode <pulse|daily|htf> [--dry-run] [--collect-only] [--input <file>]");
  process.exit(2);
}

try {
  const inputPath = flag("--input") ? argv[argv.indexOf("--input") + 1] : undefined;
  if (flag("--input") && !inputPath) {
    console.error("--input needs a file path");
    process.exit(2);
  }
  const input = inputPath ? JSON.parse(await readFile(inputPath, "utf8")) : undefined;
  const result = await runRoutine(
    { mode, dryRun: flag("--dry-run"), collectOnly: flag("--collect-only"), input, root: process.cwd() },
    { env: process.env, now: () => new Date(), log: (line) => console.log(line) },
  );
  process.exit(result.exitCode);
} catch (err) {
  console.error(`routine: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
