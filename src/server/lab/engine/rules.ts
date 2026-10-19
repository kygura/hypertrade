import type { Condition, Level, Rule } from "../types.js";
import { parseFeatureId, REGIME_PREFIX } from "./features.js";
import type { Forest, TreeNode } from "./tree.js";
import { hash64 } from "./util.js";

// Rules (LAB.md §5): every root-to-leaf path ending in a class-1 leaf, plus
// its single-condition prefix. Conditions are canonicalised so equal rules
// from different trees merge.

/**
 * Sorted by feature then op; two bounds on the same side of one feature
 * collapse to the tighter one. Null when the conditions can never hold
 * together (x < a AND x ≥ b with b ≥ a).
 */
export function canonicalConditions(conds: Condition[]): Condition[] | null {
  const out: Condition[] = [];
  for (const c of conds) {
    const same = out.find((o) => o.feature === c.feature && o.op === c.op);
    if (!same) out.push({ feature: c.feature, op: c.op, threshold: c.threshold });
    else same.threshold = c.op === "<" ? Math.min(same.threshold, c.threshold) : Math.max(same.threshold, c.threshold);
  }
  out.sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : a.op < b.op ? -1 : a.op > b.op ? 1 : 0));
  for (const lt of out) {
    if (lt.op !== "<") continue;
    const ge = out.find((o) => o.feature === lt.feature && o.op === ">=");
    if (ge && ge.threshold >= lt.threshold) return null;
  }
  return out;
}

export function conditionsKey(conds: Condition[]): string {
  return conds.map((c) => `${c.feature}${c.op}${c.threshold}`).join("&");
}

function treeRules(node: TreeNode, ids: string[], path: Condition[], out: Condition[][]): void {
  if (node.leaf) {
    if (node.cls === 1 && path.length) {
      out.push(path);
      if (path.length > 1) out.push([path[0]!]);
    }
    return;
  }
  const feature = ids[node.feature]!;
  treeRules(node.left, ids, [...path, { feature, op: "<", threshold: node.threshold }], out);
  treeRules(node.right, ids, [...path, { feature, op: ">=", threshold: node.threshold }], out);
}

/** Distinct canonical condition sets from a forest, in first-seen order. */
export function extractRules(forest: Forest, ids: string[]): Condition[][] {
  const seen = new Set<string>();
  const out: Condition[][] = [];
  for (const tree of forest.trees) {
    const raw: Condition[][] = [];
    treeRules(tree, ids, [], raw);
    for (const r of raw) {
      const c = canonicalConditions(r);
      if (!c) continue;
      const k = conditionsKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/** In-zone flags for days [from, to): every condition's feature finite and satisfied. Other days stay 0. */
export function conditionSignal(cols: Float64Array[], conds: Condition[], n: number, from = 0, to = n): Uint8Array {
  const sig = new Uint8Array(n);
  for (let t = Math.max(0, from); t < Math.min(n, to); t++) {
    let ok = 1;
    for (let k = 0; k < conds.length; k++) {
      const x = cols[k]![t]!;
      const c = conds[k]!;
      // NaN fails both comparisons.
      if (!(c.op === "<" ? x < c.threshold : x >= c.threshold)) {
        ok = 0;
        break;
      }
    }
    sig[t] = ok;
  }
  return sig;
}

/** The rule's in-zone conditions: its own, plus its regime as a condition on an in-set indicator column (so every in-zone path, funnel included, runs it through conditionSignal). */
export function zoneConditions(rule: Pick<Rule, "conditions" | "regime">): Condition[] {
  if (!rule.regime) return rule.conditions;
  return [...rule.conditions, { feature: `${REGIME_PREFIX}${[...new Set(rule.regime.trend)].sort().join(",")}|raw|0`, op: ">=", threshold: 1 }];
}

export function fmtNum(x: number): string {
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1e6 || a < 1e-3) return x.toExponential(2).replace(/\.?0+e/, "e");
  return String(Number(x.toPrecision(4)));
}

function featureText(id: string): string {
  try {
    const s = parseFeatureId(id);
    return s.transform === "raw" ? `${s.metric} raw` : `${s.metric} ${s.transform}(${s.window})`;
  } catch {
    return id;
  }
}

function condText(c: Condition): string {
  if (c.feature.startsWith(REGIME_PREFIX)) return `trend ∈ {${parseFeatureId(c.feature).metric.slice(REGIME_PREFIX.length)}}`;
  return `${featureText(c.feature)} ${c.op === "<" ? "<" : "≥"} ${fmtNum(c.threshold)}`;
}

/** "cm:CapMVRVCur z(90) < -1.12 AND ht:funding raw ≥ 0.0003" (then "AND trend ∈ {up}" with a regime) */
export function ruleText(rule: Pick<Rule, "conditions" | "regime">): string {
  return zoneConditions(rule).map(condText).join(" AND ");
}

function levelText(l: Level): string {
  const base = l.ref === "entry" ? "entry" : `${l.ref}(${l.n})`;
  return l.atr ? `${base} ${l.atr < 0 ? "−" : "+"} ${fmtNum(Math.abs(l.atr))} ATR` : base;
}

/** "stop low(7) − 0.25 ATR; target entry + 3 ATR; exit at next open when …"; "" without exits. */
export function exitText(rule: Pick<Rule, "stop" | "target" | "invalidation">): string {
  return [
    rule.stop && `stop ${levelText(rule.stop)}`,
    rule.target && `target ${levelText(rule.target)}`,
    rule.invalidation && `exit at next open when ${rule.invalidation.map(condText).join(" AND ")}`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Stable id: FNV-1a over the canonical rule (asset case-insensitive, conditions sorted). */
export function ruleId(rule: Rule): string {
  const conds = canonicalConditions(rule.conditions) ?? rule.conditions;
  return hash64(
    JSON.stringify({
      a: rule.asset.toUpperCase(),
      d: rule.direction,
      h: rule.horizonDays,
      p: rule.price ?? "ht:price",
      c: conds.map((c) => [c.feature, c.op, c.threshold]),
      // Optional parts: undefined keys drop out of the JSON, so ids of rules without them are unchanged.
      r: rule.regime && [...new Set(rule.regime.trend)].sort(),
      s: rule.stop && levelKey(rule.stop),
      t: rule.target && levelKey(rule.target),
      i: rule.invalidation && (canonicalConditions(rule.invalidation) ?? rule.invalidation).map((c) => [c.feature, c.op, c.threshold]),
    }),
  );
}

const levelKey = (l: Level) => [l.ref, l.n ?? 0, l.atr ?? 0];
