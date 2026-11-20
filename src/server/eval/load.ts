// Panels from the Lab's data (src/server/lab/providers): the same stored-then-live series the Lab reads, so the
// daily /cron/lab-collect keeps the eval's data fresh with no cron of its own. A snapshot file (the JSON written by
// `bun run eval snapshot`) gives the same panels offline.
import { loadDataset, type RegistryDeps } from "../lab/providers/registry.js";
import { buildPanel, EVAL_ASSETS, evalMetricIds, medianRatio, realizedVol, type EvalPanel, type RawPanel } from "./panel.js";

/** One asset's panel from the Lab registry. `variancePremium` is borrowed by assets without options (HYPE). */
export async function loadPanel(asset: string, deps: RegistryDeps = {}, o: { from?: string; variancePremium?: number } = {}): Promise<{ panel: EvalPanel; warnings: string[] }> {
  const ids = evalMetricIds(asset);
  const metrics = [ids.iv, ids.funding, ids.fng, ids.mvrv].filter((x): x is string => Boolean(x));
  const { dataset, warnings } = await loadDataset({ asset, metrics, from: o.from ?? "2018-01-01" }, deps);
  const raw: RawPanel = {
    asset,
    t: dataset.t,
    price: dataset.price,
    iv: ids.iv ? dataset.metrics[ids.iv] : undefined,
    funding: dataset.metrics[ids.funding],
    fng: dataset.metrics[ids.fng],
    mvrv: ids.mvrv ? dataset.metrics[ids.mvrv] : undefined,
    variancePremium: o.variancePremium,
  };
  return { panel: buildPanel(raw), warnings };
}

/** BTC first, so its implied/realized ratio is measured before HYPE borrows it. */
export async function loadPanels(assets: readonly string[] = EVAL_ASSETS, deps: RegistryDeps = {}): Promise<{ panels: EvalPanel[]; warnings: string[] }> {
  const order = [...assets].sort((a, b) => (a === "BTC" ? -1 : b === "BTC" ? 1 : 0));
  const panels: EvalPanel[] = [];
  const warnings: string[] = [];
  let vp: number | undefined;
  for (const a of order) {
    const { panel, warnings: w } = await loadPanel(a, deps, { variancePremium: vp });
    if (a === "BTC") vp = medianRatio(panel.iv, realizedVol(panel.price)) ?? undefined;
    panels.push(panel);
    warnings.push(...w.map((x) => `${a}: ${x}`));
  }
  return { panels: assets.map((a) => panels.find((p) => p.asset === a.toUpperCase())!).filter(Boolean), warnings };
}

/** Snapshot format: { t: ISO days[], <asset lower>: closes, <asset>_dvol, <asset>_fund, fng, btc_mvrv, btc_sth_rp }. */
export type Snapshot = Record<string, Array<number | null> | string[]>;

export function panelsFromSnapshot(snap: Snapshot, assets: readonly string[] = EVAL_ASSETS): EvalPanel[] {
  const t = (snap.t as string[]).map((d) => Date.parse(`${d}T00:00:00Z`));
  const col = (k: string) => (snap[k] as Array<number | null> | undefined)?.map((v) => (v === null || v === undefined ? NaN : Number(v)));
  let vp: number | undefined;
  const out: EvalPanel[] = [];
  const order = [...assets].sort((a, b) => (a === "BTC" ? -1 : b === "BTC" ? 1 : 0));
  for (const asset of order) {
    const a = asset.toLowerCase();
    const panel = buildPanel({
      asset,
      t,
      price: col(a) ?? [],
      iv: col(`${a}_dvol`),
      funding: col(`${a}_fund`),
      fng: col("fng"),
      mvrv: col(`${a}_mvrv`),
      sthRp: col(`${a}_sth_rp`),
      variancePremium: vp,
    });
    if (asset === "BTC") vp = medianRatio(panel.iv, realizedVol(panel.price)) ?? undefined;
    const first = panel.price.findIndex((x) => Number.isFinite(x));
    out.push(first > 0 ? sliceFrom(panel, first) : panel);
  }
  return assets.map((a) => out.find((p) => p.asset === a.toUpperCase())!);
}

function sliceFrom(p: EvalPanel, i: number): EvalPanel {
  return { ...p, t: p.t.slice(i), price: p.price.slice(i), iv: p.iv.slice(i), funding: p.funding.slice(i), fng: p.fng.slice(i), mvrv: p.mvrv.slice(i), sthRp: p.sthRp.slice(i) };
}

/** A snapshot of panels (the inverse of panelsFromSnapshot, on one shared calendar). */
export function snapshotOf(panels: readonly EvalPanel[]): Snapshot {
  const days = [...new Set(panels.flatMap((p) => p.t))].sort((a, b) => a - b);
  const idx = new Map(days.map((d, i) => [d, i]));
  const snap: Snapshot = { t: days.map((d) => new Date(d).toISOString().slice(0, 10)) };
  const put = (k: string, p: EvalPanel, xs: number[]) => {
    const col: Array<number | null> = new Array(days.length).fill(null);
    p.t.forEach((d, i) => {
      const v = xs[i]!;
      if (Number.isFinite(v)) col[idx.get(d)!] = v;
    });
    snap[k] = col;
  };
  for (const p of panels) {
    const a = p.asset.toLowerCase();
    put(a, p, p.price);
    if (p.ivSource === "dvol") put(`${a}_dvol`, p, p.iv);
    put(`${a}_fund`, p, p.funding);
    put(`${a}_mvrv`, p, p.mvrv);
    if (p.sthSource === "stored") put(`${a}_sth_rp`, p, p.sthRp);
    put("fng", p, p.fng);
  }
  return snap;
}
