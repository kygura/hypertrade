import { useState } from 'react'
import { AgeStamp, AsyncBody, HowToRead, Panel, PanelBody, PanelHeader, Segmented, type Term } from '../components'
import { useApi } from '../lib/api'
import type { AssetView, EvalView } from '../../server/eval/service'

// /eval — docs/EVAL.md §8. Per asset: today's regime, the simulated path fan with level odds, and the champion specs'
// last year and current position. Read-only; nothing here places an order.

const TERMS: readonly Term[] = [
  ['FAN', 'thousands of simulated 60-day paths built from history: shocks drawn from past stretches in the same regime, rescaled to today’s implied vol. Dark band: half the paths. Light band: nine in ten. Line: the median.'],
  ['TOUCH', 'share of paths that reach the level at least once before the horizon.'],
  ['CLOSE', 'share of paths that end the horizon beyond the level.'],
  ['NOW', 'what the champion spec would hold today, as a fraction of a full position. Information only.'],
]

const fmt = (x: number) => (x >= 1000 ? Math.round(x).toLocaleString('en-US') : x >= 10 ? x.toFixed(1) : x.toFixed(3))
const pct = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`)

/** Levels the operator watches, saved in the browser. Format: BTC:58500,66000;ETH:1500 */
function useLevels(): [string, (s: string) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem('eval.levels') ?? ''
    } catch {
      return ''
    }
  })
  return [
    v,
    (s) => {
      setV(s)
      try {
        localStorage.setItem('eval.levels', s)
      } catch {
        /* private mode */
      }
    },
  ]
}

function Fan({ a }: { a: AssetView }) {
  const r = a.paths
  const W = 640
  const H = 240
  const pad = { l: 56, r: 84, t: 8, b: 20 }
  const lo = Math.min(...r.bands.map((b) => b.p5), ...r.levels.map((l) => l.level))
  const hi = Math.max(...r.bands.map((b) => b.p95), ...r.levels.map((l) => l.level))
  const x = (d: number) => pad.l + (d / r.horizon) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)) * (H - pad.t - pad.b)
  const band = (a1: 'p5' | 'p25', b1: 'p95' | 'p75') =>
    r.bands.map((b, i) => `${i ? 'L' : 'M'}${x(b.day)},${y(b[a1])}`).join('') + [...r.bands].reverse().map((b) => `L${x(b.day)},${y(b[b1])}`).join('') + 'Z'
  const line = (pts: number[]) => pts.map((v, d) => `${d ? 'L' : 'M'}${x(d)},${y(v)}`).join('')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`${a.asset} simulated paths`}>
      <path d={band('p5', 'p95')} fill="var(--color-equity)" opacity={0.12} />
      <path d={band('p25', 'p75')} fill="var(--color-equity)" opacity={0.25} />
      {r.paths.slice(0, 10).map((p, i) => (
        <path key={i} d={line(p)} fill="none" stroke="var(--color-equity)" strokeWidth={0.6} opacity={0.3} />
      ))}
      <path d={line(r.bands.map((b) => b.p50))} fill="none" stroke="var(--color-equity)" strokeWidth={1.5} />
      {r.levels.map((l) => (
        <g key={l.level}>
          <line x1={pad.l} x2={W - pad.r} y1={y(l.level)} y2={y(l.level)} stroke="var(--color-amber)" strokeDasharray="4 4" strokeWidth={1} />
          <text x={W - pad.r + 4} y={y(l.level) + 4} fontSize={10} fill="var(--color-text-secondary)">
            {fmt(l.level)} · {pct(l.touch)}
          </text>
        </g>
      ))}
      {[0, Math.round(r.horizon / 2), r.horizon].map((d) => (
        <text key={d} x={x(d)} y={H - 4} fontSize={10} textAnchor="middle" fill="var(--color-text-secondary)">
          +{d}d
        </text>
      ))}
      {[lo, Math.sqrt(lo * hi), hi].map((v) => (
        <text key={v} x={pad.l - 6} y={y(v) + 4} fontSize={10} textAnchor="end" fill="var(--color-text-secondary)">
          {fmt(v)}
        </text>
      ))}
    </svg>
  )
}

function AssetPanel({ a }: { a: AssetView }) {
  const last = a.paths.bands[a.paths.bands.length - 1]!
  return (
    <Panel>
      <PanelHeader title={`${a.asset} · ${a.regime.toUpperCase()}`}>
        <span className="text-xs text-text-secondary">
          {fmt(a.spot)} · vol {Math.round(a.paths.vol0)}%{a.ivSource === 'realized' ? ' (realized)' : ''}
        </span>
      </PanelHeader>
      <PanelBody>
        <Fan a={a} />
        <p className="text-sm text-text-primary px-1 py-2">
          In {a.paths.horizon} days: median {fmt(last.p50)}, half the paths {fmt(last.p25)}–{fmt(last.p75)}, nine in ten {fmt(last.p5)}–{fmt(last.p95)}.
          {a.sthRp ? ` STH cost basis ${fmt(a.sthRp)}${a.sthSource === 'proxy' ? ' (155-day stand-in)' : ''}.` : ''}
        </p>
        <table className="w-full text-xs">
          <thead className="text-text-secondary">
            <tr>
              <th className="text-left font-normal">LEVEL</th>
              <th className="text-left font-normal">TOUCH</th>
              <th className="text-left font-normal">CLOSE</th>
              <th className="text-left font-normal">DAY</th>
            </tr>
          </thead>
          <tbody>
            {a.paths.levels.map((l) => (
              <tr key={l.level} className="border-t border-border-subtle">
                <td>{fmt(l.level)}</td>
                <td>{pct(l.touch)}</td>
                <td>{pct(l.close)}</td>
                <td>{l.medianDay ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {a.paths.races.map((q) => (
          <p key={`${q.lo}-${q.hi}`} className="text-xs text-text-secondary pt-2">
            {fmt(q.lo)} before {fmt(q.hi)}: {pct(q.loFirst)} · {fmt(q.hi)} first: {pct(q.hiFirst)}
          </p>
        ))}
        <table className="w-full text-xs mt-3">
          <thead className="text-text-secondary">
            <tr>
              <th className="text-left font-normal">CHAMPION</th>
              <th className="text-left font-normal">NOW</th>
              <th className="text-left font-normal">1Y SHARPE</th>
              <th className="text-left font-normal">1Y MAX DD</th>
            </tr>
          </thead>
          <tbody>
            {a.champions.map((c) => (
              <tr key={c.key} className="border-t border-border-subtle" title={`${c.why}\n${c.key}`}>
                <td>{c.name}</td>
                <td className={c.now > 0 ? 'text-green' : c.now < 0 ? 'text-red-text' : 'text-text-secondary'}>{c.now === 0 ? 'flat' : c.now.toFixed(2)}</td>
                <td>{c.lastYear.sharpe.toFixed(2)}</td>
                <td>{pct(c.lastYear.maxDD)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </Panel>
  )
}

export function Eval() {
  const [horizon, setHorizon] = useState('60')
  const [levels, setLevels] = useLevels()
  const [draft, setDraft] = useState(levels)
  const q = new URLSearchParams({ horizon })
  if (levels) q.set('levels', levels)
  const view = useApi<EvalView>(`/eval?${q}`)
  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">
      <Panel>
        <PanelHeader title="EVAL">{view.data && <AgeStamp generatedAt={view.data.generatedAt} thresholdHours={26} />}</PanelHeader>
        <PanelBody>
          <HowToRead terms={TERMS} className="pb-2">
            Simulated paths are what history says is plausible from here, not a forecast. The research loop that picks the champions is in docs/eval/program.md.
          </HowToRead>
          <div className="flex flex-wrap gap-2 items-center">
            <Segmented
              value={horizon}
              onChange={setHorizon}
              label="Horizon"
              options={['30', '60', '90'].map((h) => ({ value: h, label: `${h}D` }))}
            />
            <input
              className="bg-input text-sm px-2 py-1 min-w-0 flex-1"
              placeholder="levels, e.g. BTC:58500,66000;ETH:1500"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setLevels(draft.trim())}
              onKeyDown={(e) => e.key === 'Enter' && setLevels(draft.trim())}
            />
          </div>
        </PanelBody>
      </Panel>
      <AsyncBody {...view} onRetry={view.refetch} isEmpty={(d) => d.assets.length === 0} empty={{ label: 'no price history loaded yet' }}>
        {(d) => (
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-3">
            {d.assets.map((a) => (
              <AssetPanel key={a.asset} a={a} />
            ))}
          </div>
        )}
      </AsyncBody>
    </div>
  )
}
