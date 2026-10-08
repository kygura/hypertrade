import type { KeyboardEvent } from 'react'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { FiringBadge } from '../FiringBadge'
import { RuleText } from '../RuleText'
import {
  ddTone,
  fmtPct0,
  fmtSigned,
  holdoutGap,
  ruleProviders,
  signTone,
  stabWord,
  statsFor,
  type MetricDef,
  type RuleEvaluation,
  type StatsWindow,
} from '../../lib/lab'
import { DirectionWord, ProviderTag, StatCell } from './common'

// SignalCard — DESIGN.md §10.9. One RuleEvaluation: rank, the rule in our
// language (the hero), FIRING/FLAT, SAVE; then the meta line; then seven
// stat cells. WF SHARPE and HOLDOUT always sit side by side (rule 1) and
// ignore the stats window; HIT, MAX DD and TR/YR follow it.

export function SignalCard({
  rank,
  ev,
  metrics,
  window,
  saved,
  selected,
  onOpen,
  onSave,
}: {
  rank: number
  ev: RuleEvaluation
  metrics: readonly MetricDef[]
  window: StatsWindow
  saved: boolean
  selected: boolean
  onOpen: () => void
  onSave: () => void
}) {
  const s = statsFor(ev, window)
  const wf = ev.walkForward?.sharpe ?? null
  const ho = ev.holdout?.sharpe ?? null
  const gap = holdoutGap(wf, ho)
  const stab = ev.sensitivity ? stabWord(ev.sensitivity.stability) : null
  const pair = ev.rule.conditions.length > 1

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen()
    }
  }

  return (
    <article
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className={`flex flex-col gap-1.5 px-3 py-2.5 border-b border-border-subtle cursor-pointer transition-colors duration-100 ${selected ? 'bg-selected' : 'hover:bg-hover'}`}
      style={selected ? { boxShadow: 'inset 2px 0 0 var(--color-red-accent)' } : undefined}
    >
      <div className="flex items-start gap-2">
        <span className="text-xs text-text-secondary tabular pt-1">#{rank}</span>
        <RuleText rule={ev.rule} metrics={metrics} size="lg" className="flex-1 min-w-0 text-text-primary break-words" />
        <div className="flex items-center gap-2 flex-shrink-0">
          <FiringBadge firing={ev.firingNow} />
          <Button
            tier="ghost"
            disabled={saved}
            onClick={(e) => {
              e.stopPropagation()
              onSave()
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {saved ? 'SAVED ✓' : 'SAVE'}
          </Button>
        </div>
      </div>

      <div className="text-xs text-text-secondary flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-6">
        <DirectionWord direction={ev.rule.direction} />
        <span>{ev.rule.asset.toUpperCase()}</span>
        <span>·</span>
        <span>{ev.rule.horizonDays}D</span>
        <span>·</span>
        <span>{pair ? 'PAIR' : 'SINGLE'}</span>
        <span>·</span>
        {ruleProviders(ev.rule).map((p) => (
          <ProviderTag key={p} provider={p} />
        ))}
        <span>·</span>
        <span className="tabular">PRECISION {ev.precision.toFixed(2)}</span>
      </div>

      <div className="grid grid-cols-4 lg:grid-cols-7 gap-x-3 gap-y-2 pl-6">
        <StatCell label="WF SHARPE" title={wf == null ? 'not enough history' : undefined}>
          <span className={`text-base ${signTone(wf)}`}>{fmtSigned(wf)}</span>
        </StatCell>
        <StatCell label="HOLDOUT" title={ho == null ? 'not enough history' : undefined}>
          <span className={signTone(ho)}>{fmtSigned(ho)}</span>
          {gap && <Badge tone="amber">HOLDOUT GAP</Badge>}
        </StatCell>
        <StatCell label="HIT">{fmtPct0(s?.hitRate)}</StatCell>
        <StatCell label="MAX DD">
          <span className={ddTone(s?.maxDrawdown)}>{s ? fmtSigned(s.maxDrawdown * 100, 1) + '%' : '—'}</span>
        </StatCell>
        <StatCell label="TR/YR">{s ? s.tradesPerYear.toFixed(1) : '—'}</StatCell>
        <StatCell label="SUPPORT">{ev.support}</StatCell>
        <StatCell label="STAB">
          {stab && ev.sensitivity ? (
            <>
              {ev.sensitivity.stability.toFixed(2)} <span className={stab.tone}>{stab.word}</span>
            </>
          ) : (
            '—'
          )}
        </StatCell>
      </div>
    </article>
  )
}
