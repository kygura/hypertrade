// A self-contained HTML report (docs/EVAL.md §7): the fan of future paths per asset with level odds, and the
// strategy leaderboard. No scripts, no external assets: inline SVG that reads in light and dark mode.
import type { Finalist } from "./search.js";
import type { Calibration, PathResult } from "./paths.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (x: number | null | undefined, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`);
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");

export function fmtPrice(x: number): string {
  if (!Number.isFinite(x)) return "–";
  if (x >= 1000) return Math.round(x).toLocaleString("en-US");
  if (x >= 10) return x.toFixed(1);
  return x.toFixed(3);
}

/** Fan chart: 5–95 and 25–75 bands, the median, a few sample paths, and dashed level lines. */
export function fanSvg(r: PathResult, w = 720, h = 300): string {
  const pad = { l: 64, r: 96, t: 12, b: 24 };
  const xs = (d: number) => pad.l + (d / r.horizon) * (w - pad.l - pad.r);
  const lo = Math.min(...r.bands.map((b) => b.p5), ...r.levels.map((l) => l.level));
  const hi = Math.max(...r.bands.map((b) => b.p95), ...r.levels.map((l) => l.level));
  const ly = (v: number) => Math.log(v);
  const ys = (v: number) => pad.t + (1 - (ly(v) - ly(lo)) / (ly(hi) - ly(lo) || 1)) * (h - pad.t - pad.b);
  const area = (a: "p5" | "p25", b: "p95" | "p75") =>
    r.bands.map((x, i) => `${i ? "L" : "M"}${xs(x.day).toFixed(1)},${ys(x[a]).toFixed(1)}`).join("") +
    [...r.bands].reverse().map((x) => `L${xs(x.day).toFixed(1)},${ys(x[b]).toFixed(1)}`).join("") +
    "Z";
  const line = (pts: Array<[number, number]>) => pts.map(([d, v], i) => `${i ? "L" : "M"}${xs(d).toFixed(1)},${ys(v).toFixed(1)}`).join("");
  const samples = r.paths
    .slice(0, 12)
    .map((p) => `<path d="${line(p.map((v, d) => [d, v]))}" class="sample"/>`)
    .join("");
  const levels = r.levels
    .map((l) => {
      const y = ys(l.level).toFixed(1);
      return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" class="lvl"/><text x="${w - pad.r + 4}" y="${Number(y) + 4}" class="lab">${fmtPrice(l.level)} · ${pct(l.touch)}</text>`;
    })
    .join("");
  const ticks = [0, Math.round(r.horizon / 2), r.horizon]
    .map((d) => `<text x="${xs(d).toFixed(1)}" y="${h - 6}" class="lab" text-anchor="middle">+${d}d</text>`)
    .join("");
  const yt = [lo, Math.sqrt(lo * hi), hi].map((v) => `<text x="${pad.l - 6}" y="${(ys(v) + 4).toFixed(1)}" class="lab" text-anchor="end">${fmtPrice(v)}</text>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(r.asset)} path fan"><path d="${area("p5", "p95")}" class="b90"/><path d="${area("p25", "p75")}" class="b50"/>${samples}<path d="${line(r.bands.map((b) => [b.day, b.p50]))}" class="med"/>${levels}${ticks}${yt}</svg>`;
}

export interface ReportInput {
  generated: string;
  paths: PathResult[];
  calibration?: Calibration[];
  finalists?: Finalist[];
  trials?: number;
  notes?: string[];
}

export function renderReport(x: ReportInput): string {
  const fans = x.paths
    .map((r) => {
      const last = r.bands[r.bands.length - 1]!;
      const rows = r.levels
        .map((l) => `<tr><td>${fmtPrice(l.level)}</td><td>${pct(l.touch)}</td><td>${pct(l.close)}</td><td>${l.medianDay ?? "–"}</td></tr>`)
        .join("");
      const races = r.races.map((q) => `<li>${fmtPrice(q.lo)} before ${fmtPrice(q.hi)}: <b>${pct(q.loFirst)}</b> · ${fmtPrice(q.hi)} first ${pct(q.hiFirst)} · neither ${pct(q.neither)}</li>`).join("");
      const cal = x.calibration?.find((c) => c.asset === r.asset);
      return `<section><h2>${esc(r.asset)} <small>${fmtPrice(r.spot)} on ${r.asOf} · regime ${r.regime} · vol ${num(r.vol0, 0)}% (IV ${r.iv === null ? "n/a" : num(r.iv, 0)}, RV ${r.rv === null ? "n/a" : num(r.rv, 0)})</small></h2>
${fanSvg(r)}
<p>In ${r.horizon} days: median ${fmtPrice(last.p50)}, half the paths between ${fmtPrice(last.p25)} and ${fmtPrice(last.p75)}, nine in ten between ${fmtPrice(last.p5)} and ${fmtPrice(last.p95)}.</p>
<table><thead><tr><th>Level</th><th>Touch</th><th>Close beyond</th><th>Median day</th></tr></thead><tbody>${rows}</tbody></table>
${races ? `<ul>${races}</ul>` : ""}
${cal ? `<p class="muted">Calibration (${cal.samples} past forecasts, ${cal.horizon}d): ${pct(cal.in50)} landed in the middle band (aim 50%), ${pct(cal.in90)} in the outer band (aim 90%).</p>` : ""}</section>`;
    })
    .join("");
  const board = x.finalists?.length
    ? `<section><h2>Strategy leaderboard <small>holdout, ${x.trials ?? "?"} experiments</small></h2><table><thead><tr><th>Spec</th><th>Search score</th><th>Holdout score</th>${Object.keys(x.finalists[0]!.holdout)
        .map((a) => `<th>${esc(a)} Sharpe / maxDD / DSR</th>`)
        .join("")}</tr></thead><tbody>${x.finalists
        .map(
          (f) =>
            `<tr><td><code>${esc(f.key)}</code></td><td>${num(f.searchScore)}</td><td>${num(f.holdoutScore)}</td>${Object.values(f.holdout)
              .map((h) => `<td>${num(h.sharpe)} / ${pct(h.maxDD)} / ${h.deflatedSharpe === null ? "–" : num(h.deflatedSharpe)}</td>`)
              .join("")}</tr>`,
        )
        .join("")}</tbody></table></section>`
    : "";
  const notes = x.notes?.length ? `<section><h2>Notes</h2><ul>${x.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eval report</title>
<style>:root{--bg:#fbfaf7;--fg:#1d1d1b;--mut:#6b6a66;--b90:rgba(66,110,170,.14);--b50:rgba(66,110,170,.28);--med:#2f5d9a;--lvl:#b0533c;--line:#ddd9d0}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#9a988f;--b90:rgba(120,160,220,.16);--b50:rgba(120,160,220,.32);--med:#8fb3e8;--lvl:#e08a6e;--line:#33322f}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}small,.muted{color:var(--mut);font-weight:400}
svg{width:100%;height:auto}.b90{fill:var(--b90)}.b50{fill:var(--b50)}.med{fill:none;stroke:var(--med);stroke-width:2}
.sample{fill:none;stroke:var(--med);stroke-width:.6;opacity:.35}.lvl{stroke:var(--lvl);stroke-dasharray:4 4}.lab{fill:var(--mut);font-size:11px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0;display:block;overflow-x:auto}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;white-space:nowrap}code{font-size:12px}</style></head>
<body><h1>Eval report</h1><p class="muted">Generated ${esc(x.generated)}. Simulated paths are not forecasts of what will happen; they show what history says is plausible from here.</p>${fans}${board}${notes}</body></html>`;
}
