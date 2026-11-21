// The weighted read across sources. Pure arithmetic over the source reads, so the number never comes from the model:
// each read counts weight × confidence, the score is the weighted mean lean, the dispersion its weighted standard
// deviation. Glassnode (the reference) is compared with everyone else separately.
import { REFERENCE_SOURCE } from "./sources.js";
import type { Agreement, Consensus, Lean, SourceKind, SourceRead } from "./types.js";

const r2 = (x: number) => Math.round(x * 100) / 100;

function stats(reads: SourceRead[]): { mean: number; sd: number; w: number } | null {
  let w = 0;
  let s = 0;
  for (const r of reads) {
    const k = r.weight * r.confidence;
    w += k;
    s += k * r.lean;
  }
  if (w <= 0) return null;
  const mean = s / w;
  let v = 0;
  for (const r of reads) v += r.weight * r.confidence * (r.lean - mean) ** 2;
  return { mean, sd: Math.sqrt(v / w), w };
}

export function labelFor(score: number): Consensus["label"] {
  if (score <= -1.25) return "bearish";
  if (score <= -0.4) return "lean bearish";
  if (score < 0.4) return "mixed";
  if (score < 1.25) return "lean bullish";
  return "bullish";
}

/** aligned: most weight on one side and little spread; contested: real weight on both sides; thin: under 3 sources. */
export function agreementFor(reads: SourceRead[], sd: number): Agreement {
  if (reads.length < 3) return "thin";
  let bull = 0;
  let bear = 0;
  for (const r of reads) {
    const k = r.weight * r.confidence;
    if (r.lean > 0) bull += k;
    else if (r.lean < 0) bear += k;
  }
  const minority = Math.min(bull, bear) / Math.max(bull + bear, 1e-9);
  if (minority >= 0.3) return "contested";
  if (sd <= 0.8 && minority < 0.15) return "aligned";
  return "split";
}

export function consensus(reads: SourceRead[], reference = REFERENCE_SOURCE): Consensus {
  const all = stats(reads);
  const by_kind: Partial<Record<SourceKind, number>> = {};
  for (const kind of new Set(reads.map((r) => r.kind))) {
    const s = stats(reads.filter((r) => r.kind === kind));
    if (s) by_kind[kind] = r2(s.mean);
  }
  const ref = reads.find((r) => r.source === reference) ?? null;
  const field = stats(reads.filter((r) => r.source !== reference));
  let reference_vs_field: Consensus["reference_vs_field"] = "no_reference";
  if (ref && !field) reference_vs_field = "no_field";
  else if (ref && field) reference_vs_field = Math.sign(ref.lean) === Math.sign(Math.round(field.mean)) || Math.abs(ref.lean - field.mean) < 0.75 ? "agrees" : "differs";
  const score = all ? r2(all.mean) : 0;
  return {
    score,
    label: labelFor(score),
    dispersion: all ? r2(all.sd) : 0,
    agreement: agreementFor(reads, all?.sd ?? 0),
    n: reads.length,
    by_kind,
    reference: ref ? { source: ref.source, lean: ref.lean as Lean } : null,
    reference_vs_field,
  };
}
