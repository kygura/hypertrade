// bun run signals:scan            the signal-definition scan once (docs/RESEARCH.md "Signals v2" S2), no board timeout
// bun run signals:study [id…]     each definition's event study over the Lab's default universe (lab_event_study)
// Thin wrappers over the service code: the scan is the board's (signals/runtime.ts) on whatever is configured
// (DATABASE_URL, else live Hyperliquid and OKX); the study runs the lab_event_study tool as POST /research/study does,
// without its deadline, and records a trial in the Lab store as any study does.
import { STUDY_DEFAULTS } from "../src/shared/research.js";
import { databaseUrl } from "../src/server/db.js";
import type { EventStudyResult, Screen } from "../src/server/lab/engine/eventStudy.js";
import { toolEventStudy } from "../src/server/routes/research.js";
import { DEFINITIONS, definitionRule } from "../src/server/signals/definitions.js";
import { processDefinitionScanner } from "../src/server/signals/runtime.js";

const [cmd, ...args] = process.argv.slice(2);
const num = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(d));
const source = databaseUrl() ? "database" : "live Hyperliquid + OKX (no DATABASE_URL)";

if (cmd === "scan") {
  const started = Date.now();
  console.log(`definition scan: ${source}`);
  const scan = await processDefinitionScanner(process.env, Infinity).scan();
  console.log(`bar ${scan.bar} · ${scan.coins} coins scanned · ${scan.dropped} dropped · ${scan.hits.length} hits · ${((Date.now() - started) / 1000).toFixed(0)} s`);
  if (scan.drops.length) {
    console.log("\ndropped:");
    for (const d of scan.drops) console.log(`  ${d.coin}${d.definition ? ` × ${d.definition}` : ""}: ${d.reason}${d.retry ? "" : " (not retried)"}`);
  }
  console.log(scan.hits.length ? "\nhits:" : "\nhits: none");
  for (const h of scan.hits) {
    const values = Object.entries(h.values).map(([f, v]) => `${f} ${num(v, 4)}`).join(", ");
    console.log(`  ${h.coin} ${h.definition.id} (${h.definition.rule.direction}) ${h.date}: ${values}`);
  }
  process.exit(0);
} else if (cmd === "study") {
  const unknown = args.filter((a) => !DEFINITIONS.some((d) => d.id === a));
  if (unknown.length) {
    console.error(`unknown definition(s): ${unknown.join(", ")}; known: ${DEFINITIONS.map((d) => d.id).join(", ")}`);
    process.exit(2);
  }
  const defs = args.length ? DEFINITIONS.filter((d) => args.includes(d.id)) : DEFINITIONS;
  const study = toolEventStudy();
  const screen = (s: Screen) => `${s.events} ev / ${s.weeks} wk / ${num(s.expectancy)}R`;
  console.log(`event studies: ${source}; stop ${STUDY_DEFAULTS.stopAtr} ATR, target ${STUDY_DEFAULTS.targetAtr} ATR (unless the rule has its own)`);
  console.log(["id", "verdict", "events", "weeks", "expectancy R", "upper95 R", "train", "holdout", "coins used/dropped"].join(" | "));
  for (const d of defs) {
    const started = Date.now();
    try {
      const r = (await study({ rule: definitionRule(d), ...STUDY_DEFAULTS }, { source: "cli" })) as EventStudyResult & { warnings: string[]; idea: { n: number } };
      const used = r.coins.filter((c) => c.status === "ok");
      const dropped = r.coins.filter((c) => c.status !== "ok");
      console.log(
        [d.id, r.verdict, r.screen.events, r.screen.weeks, num(r.screen.expectancy), num(r.screen.upper95), screen(r.train), screen(r.holdout), `${used.length}/${dropped.length}`].join(" | ") +
          `   (${((Date.now() - started) / 1000).toFixed(0)} s, trial #${r.idea.n}, period ${r.period ? `${r.period.from}..${r.period.to}, holdout from ${r.period.holdoutFrom}` : "none"})`,
      );
      for (const c of dropped) console.log(`    dropped ${c.coin}: ${c.reason ?? c.status}`);
      for (const w of r.warnings) console.log(`    warning ${w}`);
    } catch (err) {
      console.log(`${d.id} | failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(0);
} else {
  console.error("usage: signal-defs.ts scan | study [definition id…]");
  process.exit(2);
}
