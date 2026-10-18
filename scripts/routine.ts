// bun run routine --mode <pulse|daily|htf> [--dry-run] [--collect-only]
// The provider-agnostic fallback routine (docs/fallback-routine.md). Runs from
// .github/workflows/routine.yml; writes data/setups (and, in daily mode,
// data/marketstate, data/sectors, data/lab) under the current directory.
import { runRoutine, type Mode } from "../src/server/routine/run.js";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const modeArg = argv[argv.indexOf("--mode") + 1];
const mode: Mode | null = argv.includes("--mode") ? (["pulse", "daily", "htf"].includes(modeArg ?? "") ? (modeArg as Mode) : null) : "pulse";
if (!mode) {
  console.error("usage: bun run routine --mode <pulse|daily|htf> [--dry-run] [--collect-only]");
  process.exit(2);
}

try {
  const result = await runRoutine(
    { mode, dryRun: flag("--dry-run"), collectOnly: flag("--collect-only"), root: process.cwd() },
    { env: process.env, now: () => new Date(), log: (line) => console.log(line) },
  );
  process.exit(result.exitCode);
} catch (err) {
  console.error(`routine: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
}
