import type { Rng } from "./rng.js";

// Depth-2 CART forest (LAB.md §4). Gini on quantile-binned thresholds, rows
// bootstrapped per tree, features subsampled per node.
//
// Class weights are balanced (each class carries half the weight), so a leaf
// is "majority class 1" when its good-day rate beats the training base rate.
// With labels at the top 30% tail, an unweighted majority would almost never
// produce a rule on real data.
//
// NaN policy: a row whose split feature is NaN fails both `<` and `≥`. It is
// left out of that node's split scoring and goes to neither child, the same
// way a rule with a NaN condition is out of zone.

export const NAN_CODE = 255;

export interface Binned {
  /** Per feature: ascending split thresholds (≤ bins − 1 values from the training rows). */
  thresholds: Float64Array[];
  /** Per feature, per row (all rows): number of thresholds ≤ value, or NAN_CODE. */
  codes: Uint8Array[];
}

export function binFeatures(columns: Float64Array[], rows: Int32Array, bins = 32): Binned {
  if (bins < 2 || bins > 64) throw new Error("bins must be 2..64");
  const thresholds: Float64Array[] = [];
  const codes: Uint8Array[] = [];
  const buf = new Float64Array(rows.length);
  for (const col of columns) {
    let m = 0;
    for (let i = 0; i < rows.length; i++) {
      const x = col[rows[i]!]!;
      if (x === x) buf[m++] = x;
    }
    const s = buf.slice(0, m).sort();
    const thr: number[] = [];
    for (let k = 1; k < bins && m >= 2; k++) {
      const x = s[Math.floor((k * m) / bins)]!;
      // A threshold at the minimum would leave the `<` side empty.
      if (x > s[0]! && (!thr.length || x > thr[thr.length - 1]!)) thr.push(x);
    }
    const th = Float64Array.from(thr);
    const code = new Uint8Array(col.length);
    for (let i = 0; i < col.length; i++) {
      const x = col[i]!;
      if (x !== x) {
        code[i] = NAN_CODE;
        continue;
      }
      let lo = 0;
      let hi = th.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (th[mid]! <= x) lo = mid + 1;
        else hi = mid;
      }
      code[i] = lo;
    }
    thresholds.push(th);
    codes.push(code);
  }
  return { thresholds, codes };
}

export interface TreeParams {
  featureFrac: number;
  minLeaf: number;
  bootstrapFrac: number;
  trees: number;
}

export interface Leaf {
  leaf: true;
  /** Bootstrap row count. */
  n: number;
  cls: 0 | 1;
}

export interface SplitNode {
  leaf: false;
  feature: number;
  /** Left: value < threshold. Right: value ≥ threshold. */
  threshold: number;
  gain: number;
  left: TreeNode;
  right: TreeNode;
}

export type TreeNode = Leaf | SplitNode;

export interface Forest {
  trees: TreeNode[];
  /** Impurity decrease per feature, summed over trees, each tree normalised by its root weight. */
  importance: Float64Array;
}

const gini = (w: number, p: number) => (w > 0 ? (2 * p * (w - p)) / w : 0);

/** Grows a forest on `rows` (each with a finite 0/1 label). */
export function growForest(binned: Binned, labels: Float64Array, rows: Int32Array, params: TreeParams, rng: Rng): Forest {
  const F = binned.codes.length;
  const importance = new Float64Array(F);
  const m = rows.length;
  let nPos = 0;
  for (let i = 0; i < m; i++) if (labels[rows[i]!] === 1) nPos++;
  if (!F || !nPos || nPos === m) return { trees: [], importance };
  const cw = [m / (2 * (m - nPos)), m / (2 * nPos)];
  const n = labels.length;
  const counts = new Uint16Array(n);
  const order = Int32Array.from({ length: F }, (_, i) => i);
  const mtry = Math.min(F, Math.max(1, Math.round(params.featureFrac * F)));
  const draws = Math.max(2, Math.round(params.bootstrapFrac * m));
  const minLeaf = Math.max(1, Math.round(params.minLeaf));
  const hc = new Float64Array(64);
  const hw = new Float64Array(64);
  const hp = new Float64Array(64);
  const trees: TreeNode[] = [];

  const leafOf = (nodeRows: Int32Array): Leaf => {
    let w = 0;
    let wp = 0;
    let c = 0;
    for (let i = 0; i < nodeRows.length; i++) {
      const r = nodeRows[i]!;
      const y = labels[r]!;
      const ww = counts[r]! * cw[y]!;
      c += counts[r]!;
      w += ww;
      if (y === 1) wp += ww;
    }
    return { leaf: true, n: c, cls: wp > w - wp ? 1 : 0 };
  };

  for (let tree = 0; tree < params.trees; tree++) {
    for (let i = 0; i < m; i++) counts[rows[i]!] = 0;
    for (let i = 0; i < draws; i++) counts[rows[Math.floor(rng() * m)]!]!++;
    let u = 0;
    for (let i = 0; i < m; i++) if (counts[rows[i]!]! > 0) u++;
    const uniq = new Int32Array(u);
    let rootW = 0;
    u = 0;
    for (let i = 0; i < m; i++) {
      const r = rows[i]!;
      if (counts[r]! > 0) {
        uniq[u++] = r;
        rootW += counts[r]! * cw[labels[r]!]!;
      }
    }

    const grow = (nodeRows: Int32Array, depth: number): TreeNode => {
      if (depth >= 2 || nodeRows.length < 2) return leafOf(nodeRows);
      // Partial Fisher-Yates: the first mtry slots of `order` are this node's features.
      for (let i = 0; i < mtry; i++) {
        const j = i + Math.floor(rng() * (F - i));
        const tmp = order[i]!;
        order[i] = order[j]!;
        order[j] = tmp;
      }
      let bestGain = 1e-12;
      let bestF = -1;
      let bestJ = -1;
      for (let fi = 0; fi < mtry; fi++) {
        const f = order[fi]!;
        const T = binned.thresholds[f]!.length;
        if (!T) continue;
        const codes = binned.codes[f]!;
        hc.fill(0, 0, T + 1);
        hw.fill(0, 0, T + 1);
        hp.fill(0, 0, T + 1);
        for (let i = 0; i < nodeRows.length; i++) {
          const r = nodeRows[i]!;
          const b = codes[r]!;
          if (b === NAN_CODE) continue;
          const c = counts[r]!;
          const y = labels[r]!;
          const ww = c * cw[y]!;
          hc[b] += c;
          hw[b] += ww;
          if (y === 1) hp[b] += ww;
        }
        let C = 0;
        let W = 0;
        let P = 0;
        for (let b = 0; b <= T; b++) {
          C += hc[b]!;
          W += hw[b]!;
          P += hp[b]!;
        }
        if (C < 2 * minLeaf) continue;
        const parent = gini(W, P);
        let cL = 0;
        let wL = 0;
        let pL = 0;
        for (let j = 0; j < T; j++) {
          cL += hc[j]!;
          wL += hw[j]!;
          pL += hp[j]!;
          if (cL < minLeaf) continue;
          if (C - cL < minLeaf) break;
          const gain = parent - gini(wL, pL) - gini(W - wL, P - pL);
          if (gain > bestGain) {
            bestGain = gain;
            bestF = f;
            bestJ = j;
          }
        }
      }
      if (bestF < 0) return leafOf(nodeRows);
      const codes = binned.codes[bestF]!;
      let nl = 0;
      let nr = 0;
      for (let i = 0; i < nodeRows.length; i++) {
        const b = codes[nodeRows[i]!]!;
        if (b === NAN_CODE) continue;
        if (b <= bestJ) nl++;
        else nr++;
      }
      const L = new Int32Array(nl);
      const R = new Int32Array(nr);
      nl = nr = 0;
      for (let i = 0; i < nodeRows.length; i++) {
        const r = nodeRows[i]!;
        const b = codes[r]!;
        if (b === NAN_CODE) continue;
        if (b <= bestJ) L[nl++] = r;
        else R[nr++] = r;
      }
      importance[bestF] += bestGain / rootW;
      return {
        leaf: false,
        feature: bestF,
        threshold: binned.thresholds[bestF]![bestJ]!,
        gain: bestGain,
        left: grow(L, depth + 1),
        right: grow(R, depth + 1),
      };
    };
    trees.push(grow(uniq, 0));
  }
  return { trees, importance };
}
