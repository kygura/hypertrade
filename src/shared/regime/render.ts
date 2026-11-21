// The thesis as Markdown, laid out like the Weekly Tape: TL;DR, regime read, key levels, lines, scenarios, how the
// sources lean (with the reference called out), catalysts, narratives, what changed, and the changelog. Used for the
// GitHub job summary, the CLI and anywhere a plain document is wanted.
import type { HistoryEntry, Lean, RegimeThesis } from "./types.js";

const cell = (x: string | number | null | undefined) => String(x ?? "").replace(/\|/g, "/").replace(/\n+/g, " ").trim() || "-";
const leanText = (l: Lean) => (["strongly bearish", "bearish", "neutral", "bullish", "strongly bullish"] as const)[l + 2];
const stanceText = (s: RegimeThesis["stance"]) => s.replace("_", "-");
const day = (iso: string) => iso.slice(0, 10);

export function renderThesis(t: RegimeThesis, history: HistoryEntry[] = []): string {
  const c = t.consensus;
  const out: string[] = [];
  out.push(`# Regime thesis v${t.version}`, "");
  out.push(`_${day(t.created)} · ${t.model} · ${t.source_reads.length} sources_`, "");
  out.push(`> **${t.phase}**  `, `> Stance ${stanceText(t.stance)}, ${t.conviction} conviction. Field ${c.label} (${c.score >= 0 ? "+" : ""}${c.score}), ${c.agreement}.`, "");
  if (t.tldr) out.push(t.tldr, "");

  out.push("## Regime read", "");
  if (t.macro) out.push(`**Macro.** ${t.macro}`, "");
  if (t.alts) out.push(`**Alts.** ${t.alts}`, "");

  if (t.key_levels.length) {
    out.push("## Key levels", "", "| Metric | Level | Meaning | Status |", "|---|---|---|---|");
    for (const k of t.key_levels) out.push(`| ${cell(k.metric)} | ${cell(k.level)} | ${cell(k.meaning)} | ${cell(k.status)} |`);
    out.push("");
  }

  if (t.lines.length) {
    const name = { bull_confirm: "Confirms the bull case", bear_trigger: "Triggers the bear case", invalidation: "Invalidates the thesis" } as const;
    out.push("## Lines", "");
    for (const l of t.lines) out.push(`- **${name[l.kind]}:** ${l.text}`);
    out.push("");
  }

  if (t.scenarios.length) {
    out.push("## Scenarios", "", "| Scenario | Odds | Path | Trigger |", "|---|---|---|---|");
    for (const x of t.scenarios) out.push(`| ${cell(x.name)} | ${Math.round(x.probability * 100)}% | ${cell(x.path)} | ${cell(x.trigger)} |`);
    out.push("");
  }

  out.push("## How the sources lean", "");
  if (c.reference) {
    const ref = t.source_reads.find((r) => r.source === c.reference!.source);
    const vs = { agrees: "the rest of the field agrees", differs: "the rest of the field differs", no_field: "no other source to compare", no_reference: "" }[c.reference_vs_field];
    out.push(`**Reference, ${ref?.name ?? c.reference.source}: ${leanText(c.reference.lean)}; ${vs}.** ${ref?.claim ?? ""}`.trim(), "");
  } else out.push("_The reference source had nothing new in this version._", "");
  if (t.agreement_notes) out.push(t.agreement_notes, "");
  if (t.source_reads.length) {
    out.push("| Source | Kind | Lean | Weight | Claim |", "|---|---|---|---|---|");
    const rows = [...t.source_reads].sort((a, b) => b.weight * b.confidence - a.weight * a.confidence);
    for (const r of rows) {
      const name = r.url ? `[${cell(r.name)}](${r.url})` : cell(r.name);
      out.push(`| ${name} | ${r.kind.replace("_", " ")} | ${r.lean > 0 ? "+" : ""}${r.lean} | ${(r.weight * r.confidence).toFixed(2)} | ${cell(r.claim)} |`);
    }
    out.push("");
  }

  const upcoming = t.catalysts.filter((x) => x.status === "upcoming");
  if (upcoming.length) {
    out.push("## Catalysts", "", "| Date | Event | Why it matters |", "|---|---|---|");
    for (const x of upcoming) out.push(`| ${cell(x.date)} | ${cell(x.event)} | ${cell(x.why)} |`);
    out.push("");
  }

  if (t.narratives.length) {
    out.push("## Plays and narratives", "");
    for (const n of t.narratives) out.push(`- **${n.name}:** ${n.read}`);
    out.push("");
  }

  if (t.changes.length) {
    out.push("## What changed", "");
    for (const x of t.changes) out.push(`- **${x.what}:** ${x.from ? `${x.from} → ` : ""}${x.to}. ${x.because}`);
    out.push("");
  }

  out.push("## Changelog", "");
  const rows = history.length ? history : [{ version: t.version, created: t.created, phase: t.phase, changelog: t.changelog }];
  for (const h of rows.slice(0, 20)) out.push(`- **${h.version ? `v${h.version}` : "notes"} · ${day(h.created)} · ${h.phase}.** ${h.changelog}`);
  out.push("");

  if (t.sources.length) {
    out.push("## Sources", "");
    for (const l of t.sources) out.push(`- [${l.title.replace(/[[\]]/g, "")}](${l.url})`);
    out.push("");
  }
  return out.join("\n");
}
