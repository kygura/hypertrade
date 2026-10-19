import type { BullEpisode, CoolingHigh, CycleForecast, EstimateMethod, OnsetKind } from '../../../shared/cycleForecast'
import { DAY_MS, type CycleCoin } from '../../../shared/cycles'
import { fmtPct } from '../../../shared/format'
import { DataTable, type Column } from '../DataTable'
import { MetricStat } from '../MetricStat'
import { fmtDay, fmtDays, fmtMonth, fmtQuarter, fmtUsdPx, PHASE_LABEL } from './format'

// The estimate itself: headline window, today's position in the cycle, the
// four timing methods with every past offset they use, and the bull runs
// they were measured on.

const METHOD_NOTE: Record<EstimateMethod['key'], (m: EstimateMethod, coin: CycleCoin) => string> = {
  rhythm: () => 'spacing between past run starts, repeated from the latest start',
  halving: (m, coin) =>
    `each run’s start relative to its nearest ${coin === 'BTC' ? '' : 'BTC '}halving, applied to the ${new Date(m.anchor.t).getUTCFullYear()} halving`,
  low: () => 'days from each bear-market low to the next run start, from the low since the last top',
  top: (m) => `days from each cycle top to the next run start, from the ${m.anchor.label}`,
}

/** Date a run by the selected start. */
export const runStart = (e: BullEpisode, kind: OnsetKind) => (kind === 'breakout' ? e.breakout.t : e.start)

const KIND_NOTE: Record<OnsetKind, string> = {
  breakout: 'Run start = where the final doubling into euphoria began: the first close of the run-up that stays above half the price on euphoria’s first day.',
  euphoria: 'Run start = first day the model commits to EUPHORIA, which in past cycles came within days of a new all-time high.',
}

export function ForecastHero({ forecast, other }: { forecast: CycleForecast; other: CycleForecast }) {
  const { onset, top, status, kind } = forecast
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
        <span className="text-[10px] text-text-secondary [text-transform:var(--label-case)] tracking-[var(--label-tracking)]">next bull run start, central estimate if past cycles repeat</span>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-[22px] leading-none text-text-primary tabular">{fmtMonth(onset.median)}</span>
        <span className="text-[13px] text-text-muted tabular">
          core {fmtMonth(onset.p25)} – {fmtMonth(onset.p75)} · range {fmtMonth(onset.min)} – {fmtMonth(onset.max)}
        </span>
      </div>
      {top && (
        <span className="text-[11px] text-text-secondary tabular">
          the run could peak around <span className="text-text-primary">{fmtQuarter(top.median)}</span> (core {fmtMonth(top.p25)} – {fmtMonth(top.p75)}), going by past
          start-to-top lengths of {runLengths(forecast.episodes, kind)}.
        </span>
      )}
      <span className="text-[11px] text-text-secondary">
        {KIND_NOTE[kind]} Past starts: {pastStarts(forecast.episodes, kind)}. Core = middle half of the{' '}
        {forecast.methods.reduce((n, m) => n + m.samples.length, 0)} candidate dates below.
        {other.onset && (
          <>
            {' '}
            Dated from {other.kind} instead: {fmtMonth(other.onset.median)}.
          </>
        )}
      </span>
    </div>
  )
}

function runLengths(episodes: BullEpisode[], kind: OnsetKind): string {
  return episodes
    .filter((e) => e.lowConfirmed)
    .map((e) => fmtDays(Math.round((e.top.t - runStart(e, kind)) / DAY_MS)))
    .join(', ')
}

function pastStarts(episodes: BullEpisode[], kind: OnsetKind): string {
  return episodes.map((e) => fmtMonth(runStart(e, kind))).join(', ')
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

export function MethodsTable({ forecast, coin }: { forecast: CycleForecast; coin: CycleCoin }) {
  const columns: Column<EstimateMethod>[] = [
    {
      key: 'method',
      label: 'Method',
      priority: 1,
      render: (m) => (
        <span className="flex flex-col py-0.5">
          <span className="text-text-primary">{m.label}</span>
          <span className="text-[10px] text-text-secondary whitespace-normal">{METHOD_NOTE[m.key](m, coin)}</span>
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

export function EpisodesTable({ episodes, kind }: { episodes: BullEpisode[]; kind: OnsetKind }) {
  const date = (t: number, on: boolean) => <span className={`whitespace-nowrap ${on ? 'text-text-primary' : ''}`}>{fmtDay(t)}</span>
  const columns: Column<BullEpisode>[] = [
    { key: 'breakout', label: 'Breakout', priority: 1, render: (e) => date(e.breakout.t, kind === 'breakout') },
    { key: 'breakoutPx', label: 'Price', priority: 3, align: 'right', render: (e) => fmtUsdPx(e.breakout.price) },
    { key: 'onset', label: 'Euphoria', priority: 2, render: (e) => date(e.start, kind === 'euphoria') },
    { key: 'onsetPx', label: 'Price', priority: 4, align: 'right', render: (e) => fmtUsdPx(e.startPrice) },
    { key: 'top', label: 'Top', priority: 1, render: (e) => <span className="whitespace-nowrap">{fmtDay(e.top.t)}</span> },
    { key: 'topPx', label: 'Top price', priority: 2, align: 'right', render: (e) => fmtUsdPx(e.top.price) },
    { key: 'len', label: 'Start→top', priority: 2, align: 'right', render: (e) => fmtDays(Math.round((e.top.t - runStart(e, kind)) / DAY_MS)) },
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

export function CoolingHighsTable({ highs }: { highs: CoolingHigh[] }) {
  const columns: Column<CoolingHigh>[] = [
    { key: 'date', label: 'High', priority: 1, render: (h) => <span className="text-text-primary whitespace-nowrap">{fmtDay(h.t)}</span> },
    { key: 'price', label: 'Close', priority: 1, align: 'right', render: (h) => fmtUsdPx(h.price) },
    { key: 'heat', label: 'Heat', priority: 1, align: 'right', render: (h) => h.heat.toFixed(2) },
    { key: 'prev', label: 'Previous high', priority: 2, render: (h) => <span className="whitespace-nowrap">{fmtDay(h.prev.t)}</span> },
    { key: 'prevPrice', label: 'Close', priority: 3, align: 'right', render: (h) => fmtUsdPx(h.prev.price) },
    { key: 'prevHeat', label: 'Heat', priority: 2, align: 'right', render: (h) => h.prev.heat.toFixed(2) },
    {
      key: 'delta',
      label: 'Price / heat',
      priority: 1,
      align: 'right',
      render: (h) => (
        <span className="whitespace-nowrap">
          {fmtPct(h.price / h.prev.price - 1, { decimals: 0, sign: true })} / {(h.heat - h.prev.heat).toFixed(2)}
        </span>
      ),
    },
  ]
  return (
    <DataTable
      columns={columns}
      rows={[...highs].reverse()}
      rowKey={(h) => String(h.t)}
      emptyLabel={<div className="p-3 text-[11px] text-text-secondary">no all-time-high leg has peaked on lower heat than the one before</div>}
    />
  )
}
