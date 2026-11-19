// bun run regime <command> — the living regime thesis (docs/REGIME.md).
//   update [--if-new]        collect, ask the strong tier for the next version, save it (--if-new: only when a report or
//                            note arrived that the thesis has not read yet)
//   show [--json]            print the current thesis as Markdown (or JSON)
//   collect                  run the collectors and print what they found; writes nothing
//   seed <file> [--force]    write the first version from a seed file (notes already shaped; keep it out of the repo)
//   status                   one line: store, version, phase (what the workflow logs; no thesis text)
// Store: Postgres with DATABASE_URL; else REGIME_STORE_FILE, or ~/.hypertrade/regime.json with REGIME_LOCAL=1.
// Model: the Desk's PM tier (ANTHROPIC_API_KEY or ANALYST_* settings, DESK_ANALYST_MODEL). Spend cap per run:
// REGIME_MAX_USD (default 3). REGIME_MARKDOWN=<path> also writes the Markdown there.
import { readFileSync, writeFileSync } from "node:fs";
import { renderThesis } from "../src/shared/regime/render";
import type { RegimeThesis } from "../src/shared/regime/types";
import { releaseConnection } from "../src/server/db";
import { intelProviderFactory } from "../src/server/intel/llm";
import { MemoryLlmCache } from "../src/server/routine/llm";
import { getCtxs } from "../src/server/routes/hl";
import { RegimeSeedError, collect, seedRegime, updateRegime, type RegimeDeps, type SeedFile } from "../src/server/regime/run";
import { defaultRegimeStore, type RegimeStore } from "../src/server/regime/store";

const env = process.env as Record<string, string | undefined>;
const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));

const line = (t: RegimeThesis) =>
  `v${t.version} (${t.model}, ${t.created.slice(0, 10)}): ${t.source_reads.length} sources, field ${t.consensus.label} ${t.consensus.score} (${t.consensus.agreement}), ${t.usage.web_searches} searches`;

async function markdown(store: RegimeStore): Promise<string | null> {
  const t = await store.thesis();
  if (!t) return null;
  const md = renderThesis(t, await store.history(60));
  if (env.REGIME_MARKDOWN?.trim()) writeFileSync(env.REGIME_MARKDOWN.trim(), md);
  return md;
}

function deps(store: RegimeStore): RegimeDeps {
  const usd = Number(env.REGIME_MAX_USD);
  return {
    store,
    env,
    now: () => new Date(),
    ctxs: async () => (await getCtxs()).ctxs,
    // A fresh counter per run: the cap bounds one rewrite (a retry included), not the day's other intel calls.
    llm: { makeProvider: intelProviderFactory(env), cache: new MemoryLlmCache(), now: () => new Date(), dailyCap: 3, dailyUsd: Number.isFinite(usd) && usd > 0 ? usd : 3 },
  };
}

async function main(): Promise<number> {
  const store = defaultRegimeStore(env);
  switch (cmd) {
    case "update": {
      console.error(`[regime] store: ${store.kind}`);
      const r = await updateRegime(deps(store), { ifNew: flags.has("--if-new") });
      for (const n of r.notes) console.error(`[regime] note: ${n}`);
      if (r.status === "failed") {
        console.error(`[regime] ${r.error}`);
        return 1;
      }
      if (r.status !== "written") {
        console.log(r.reason);
        return 0;
      }
      console.log(`Wrote ${line(r.thesis)}.`);
      await markdown(store);
      return 0;
    }
    case "show": {
      const t = await store.thesis();
      if (!t) {
        console.log("No thesis yet. Run `bun run regime seed <file>` or `bun run regime update`.");
        return 0;
      }
      console.log(flags.has("--json") ? JSON.stringify(t, null, 2) : await markdown(store));
      return 0;
    }
    case "status": {
      const t = await store.thesis();
      console.log(`store ${store.kind}: ${t ? line(t) : "no thesis yet"}`);
      return 0;
    }
    case "collect": {
      const r = await collect(deps(store));
      for (const e of r.evidence) console.log(`- [${e.source}] ${e.title}${e.url ? ` <${e.url}>` : ""}: ${e.text.slice(0, 240).replace(/\n/g, " ")}`);
      for (const n of r.notes) console.log(`note: ${n}`);
      return 0;
    }
    case "seed": {
      const file = args[0] ?? env.REGIME_SEED_FILE?.trim();
      if (!file) {
        console.error("seed needs a file: bun run regime seed <file> [--force] (or REGIME_SEED_FILE)");
        return 2;
      }
      const seed = JSON.parse(readFileSync(file, "utf8")) as SeedFile;
      const t = await seedRegime(store, seed, { force: flags.has("--force"), now: new Date() });
      console.log(`Seeded ${line(t)} into the ${store.kind} store.`);
      return 0;
    }
    default:
      console.error("Usage: bun run regime update [--if-new] | show [--json] | status | collect | seed <file> [--force]");
      return 2;
  }
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    if (!(e instanceof RegimeSeedError)) throw e;
    console.error(e.message);
  } finally {
    await releaseConnection().catch(() => {});
  }
  process.exit(code);
}
