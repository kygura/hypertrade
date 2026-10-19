import type { BullEpisode, CycleForecast, EstimateMethod } from '../../../shared/cycleForecast'
import { DAY_MS } from '../../../shared/cycles'
import { fmtPct } from '../../../shared/format'
import { DataTable, type Column } from '../DataTable'
import { MetricStat } from '../MetricStat'
import { fmtDay, fmtDays, fmtMonth, fmtQuarter, fmtUsdPx, PHASE_LABEL } from './format'

// The estimate itself: headline window, today's position in the cycle, the
// four timing methods with every past offset they use, and the bull runs
// they were measured on.

const METHOD_NOTE: Record<EstimateMethod['key'], string> = {
  rhythm: 'onset-to-onset spacing of past runs, repeated from the 2024 onset',
  halving: 'each run’s onset relative to its nearest halving, applied to the 2028 halving',
  low: 'days from each bear-market low to the next onset, from the low since the last top',
  top: 'days from each cycle top to the next onset, from the 2025 top',
}

export function ForecastHero({ forecast }: { forecast: CycleForecast }) {
  const { onset, top, status } = forecast
  if (status === 'in_run') {
    return (
      <div className="p-3 text-[13px] text-text-muted">
        A bull run is in progress (euphoria within the last 90 days and price within 35% of the top). The next-run estimate resumes once
        the cycle tops out.
      </div>
    )
  }
  if (!onset) return <div className="p-3 text-[13px] text-text-muted">Not enough history for an estimate: it needs two completed bull runs.</div>
  return (
    <div className="p-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] text-text-secondary [text-transform:var(--label-case)] tracking-[var(--label-tracking)]">next bull run, central estimate</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[22px] leading-none text-text-primary tabular">{fmtMonth(onset.median)}</span>
        <span className="text-[13px] text-text-muted tabular">
          core {fmtMonth(onset.p25)} – {fmtMonth(onset.p75)} · range {fmtMonth(onset.min)} – {fmtMonth(onset.max)}
        </span>
      </div>
      {top && (
        <span className="text-[11px] text-text-secondary tabular">
          run peaks around <span className="text-text-primary">{fmtQuarter(top.median)}</span> (core {fmtMonth(top.p25)} – {fmtMonth(top.p75)}), using past
          onset-to-top lengths of {runLengths(forecast.episodes)}.
        </span>
      )}
      <span className="text-[11px] text-text-secondary">
        Onset = first day the model commits to <span style={{ color: 'var(--color-ph-euphoria)' }}>EUPHORIA</span>, which in past cycles came
        within days of a new all-time high. Core = middle half of the {forecast.methods.reduce((n, m) => n + m.samples.length, 0)} candidate
        dates below.
      </span>
    </div>
  )
}

function runLengths(episodes: BullEpisode[]): string {
  return episodes
    .filter((e) => e.lowConfirmed)
    .map((e) => fmtDays(Math.round((e.top.t - e.start) / DAY_MS)))
    .join(', ')
}

export function ReadinessStrip({ forecast }: { forecast: CycleForecast }) {
  const r = forecast.readiness
  if (!r) return null
  const past = r.priorBearDepths.map((d) => fmtPct(d, { decimals: 0 })).join(' / ')
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 border-t border-border-subtle">
      <MetricStat label="Phase" value={r.phase ? PHASE_LABEL[r.phase] : '—'} delta={r.phaseSince ? `since ${fmtDay(r.phaseSince)}` : null} />
      <MetricStat
        label="Since cycle top"
        value={fmtDays(r.daysSinceTop)}
        delta={r.elapsed != null ? `${fmtPct(r.elapsed, { decimals: 0 })} of the median top→next-run gap` : null}
      />
      <MetricStat label="From top" value={fmtPct(r.drawdown, { decimals: 1 })} delta={fmtUsdPx(r.price)} />
      <MetricStat
        label="Bear low (so far)"
        value={r.lowDepth != null ? fmtPct(r.lowDepth, { decimals: 0 }) : '—'}
        delta={r.low ? `${fmtDay(r.low.t)} · past bears ${past}` : null}
      />
      <MetricStat label="Off the low" value={r.bounce != null ? fmtPct(r.bounce, { decimals: 0, sign: true }) : '—'} delta={r.low ? fmtUsdPx(r.low.price) : null} />
      <MetricStat label="To ATH" value={fmtPct(r.toAth, { decimals: 0, sign: true })} delta={`${fmtUsdPx(r.ath.price)} · ${fmtDay(r.ath.t)}`} />
    </div>
  )
}

export function MethodsTable({ forecast }: { forecast: CycleForecast }) {
  const columns: Column<EstimateMethod>[] = [
    {
      key: 'method',
      label: 'Method',
      priority: 1,
      render: (m) => (
        <span className="flex flex-col py-0.5">
          <span className="text-text-primary">{m.label}</span>
          <span className="text-[10px] text-text-secondary whitespace-normal">{METHOD_NOTE[m.key]}</span>
        </span>
      ),
    },
    {
      key: 'anchor',
      label: 'Anchor',
      priority: 3,
      render: (m) => (
        <span className="whitespace-nowrap">
          {fmtDay(m.anchor.t)}
          {m.anchor.estimated && <span className="text-text-secondary"> est.</span>}
        </span>
      ),
    },
    {
      key: 'samples',
      label: 'Past offsets → date',
      priority: 2,
      render: (m) => (
        <span className="flex flex-col py-0.5 text-[10px]">
          {m.samples.map((s) => (
            <span key={s.cycle} className="whitespace-nowrap">
              <span className="text-text-secondary">{s.cycle}</span> {s.days >= 0 ? '+' : ''}
              {fmtDays(s.days)} → {fmtMonth(s.date)}
            </span>
          ))}
        </span>
      ),
    },
    { key: 'median', label: 'Median', priority: 1, align: 'right', render: (m) => <span className="text-text-primary whitespace-nowrap">{fmtMonth(m.median)}</span> },
    {
      key: 'range',
      label: 'Range',
      priority: 3,
      align: 'right',
      render: (m) => (
        <span className="whitespace-nowrap">
          {fmtMonth(m.from)} – {fmtMonth(m.to)}
        </span>
      ),
    },
  ]
  return <DataTable columns={columns} rows={forecast.methods} rowKey={(m) => m.key} emptyLabel={<div className="p-3 text-[11px] text-text-secondary">no estimate</div>} />
}

export function EpisodesTable({ episodes }: { episodes: BullEpisode[] }) {
  const columns: Column<BullEpisode>[] = [
    { key: 'onset', label: 'Run onset', priority: 1, render: (e) => <span className="text-text-primary whitespace-nowrap">{fmtDay(e.start)}</span> },
    { key: 'onsetPx', label: 'Price', priority: 3, align: 'right', render: (e) => fmtUsdPx(e.startPrice) },
    { key: 'top', label: 'Top', priority: 1, render: (e) => <span className="whitespace-nowrap">{fmtDay(e.top.t)}</span> },
    { key: 'topPx', label: 'Top price', priority: 2, align: 'right', render: (e) => fmtUsdPx(e.top.price) },
    { key: 'len', label: 'Onset→top', priority: 2, align: 'right', render: (e) => fmtDays(Math.round((e.top.t - e.start) / DAY_MS)) },
    {
      key: 'low',
      label: 'Bear low',
      priority: 3,
      render: (e) =>
        e.low ? (
          <span className="whitespace-nowrap">
            {fmtDay(e.low.t)}
            {!e.lowConfirmed && <span className="text-amber"> provisional</span>}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'depth',
      label: 'Depth',
      priority: 1,
      align: 'right',
      render: (e) => (e.low ? <span className="text-red-text">{fmtPct(e.low.price / e.top.price - 1, { decimals: 0 })}</span> : '—'),
    },
  ]
  return <DataTable columns={columns} rows={episodes} rowKey={(e) => String(e.start)} />
}
