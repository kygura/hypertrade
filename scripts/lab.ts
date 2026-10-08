// Lab CLI: backfill sources and run research from a terminal or the cloud
// routine, against DATABASE_URL.
//
//   bun run lab sync [--force] [--only bc.hash-rate,fng.value]
//   bun run lab search [--direction long|short] [--bases a,b] [--effort quick|standard|deep] [--from YYYY-MM-DD] [--out file.json]
//   bun run lab evaluate '{"direction":"long","conditions":[{"feature":"cm.btc.CapMVRVCur|z365","op":"<","q":0.2}]}'
//   bun run lab catalogue
import { writeFileSync } from "node:fs";
import { releaseConnection } from "../src/server/db.js";
import { collectLab } from "../src/server/lab/sources.js";
import { compactReport, labCatalogue, labEvaluate, labSearch } from "../src/server/lab/service.js";
import { LabRuleSchema } from "../src/shared/lab.js";

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function main() {
  switch (cmd) {
    case "sync":
      print(await collectLab(fetch, undefined, { force: rest.includes("--force"), only: list(flag("only")) }));
      return;
    case "search": {
      const res = await labSearch(
        {
          direction: (flag("direction") as "long" | "short" | undefined) ?? "long",
          bases: list(flag("bases")),
          effort: (flag("effort") as "quick" | "standard" | "deep" | undefined) ?? "standard",
          from: flag("from"),
        },
        { persist: true },
      );
      const out = flag("out");
      if (out) writeFileSync(out, `${JSON.stringify(res, null, 2)}\n`);
      print({ runId: res.runId, range: res.range, trials: res.trials, elapsedMs: res.elapsedMs, warnings: res.warnings, results: res.results.map(compactReport) });
      return;
    }
    case "evaluate": {
      const rule = LabRuleSchema.parse(JSON.parse(rest[0] ?? "{}"));
      print(compactReport(await labEvaluate({ rule, from: flag("from") })));
      return;
    }
    case "catalogue":
      print(await labCatalogue());
      return;
    default:
      console.error("usage: bun run lab <sync|search|evaluate|catalogue> [options]");
      process.exitCode = 2;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => releaseConnection());
