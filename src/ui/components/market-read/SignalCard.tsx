import { Link } from 'react-router'
import { SIGNAL, type Signal, type SignalKind } from '../../../shared/signals'
import { Badge } from '../Badge'
import { EmptyBlock } from '../state'

// SIGNALS — one card per unusual coin from deriveSignals (src/shared/signals.ts): the fact,
// its evidence, why it can matter and the rule that fired. Never a verdict.

export const KIND_LABEL: Record<SignalKind, string> = {
  funding_extreme: 'FUNDING EXTREME',
  basis: 'BASIS',
  outsized_move: 'OUTSIZED MOVE',
  turnover: 'TURNOVER',
  at_cap: 'AT OI CAP',
  venue_gap: 'VENUE GAP',
}

/** The thresholds every signal kind uses, in words (the empty state lists them). */
export const THRESHOLDS = [
  `funding ≥ ${SIGNAL.fundingAprAbs}% APR either side`,
  `premium ≥ ${SIGNAL.premiumBpsAbs} bp either side`,
  `24h move or turnover ≥ ${SIGNAL.zMin} robust z from the median perp`,
  `HL vs Binance funding gap ≥ ${SIGNAL.venueGapPts} pts APR`,
  'coin at its open-interest cap',
]

export function SignalCard({ signal, link = true }: { signal: Signal; link?: boolean }) {
  const href = `/markets/${encodeURIComponent(signal.coin)}`
  return (
    <div className="flex flex-col gap-2 p-3 border border-border bg-panel min-w-0">
      <div className="flex items-center justify-between gap-2">
        <Badge tone="amber">{KIND_LABEL[signal.kind]}</Badge>
        {link ? (
          <Link to={href} className="text-md text-text-primary hover:underline">
            {signal.coin} →
          </Link>
        ) : (
          <span className="text-md text-text-primary">{signal.coin}</span>
        )}
      </div>
      {link ? (
        <Link to={href} className="text-base text-text-primary hover:underline">
          {signal.sentence}
        </Link>
      ) : (
        <p className="text-base text-text-primary">{signal.sentence}</p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {signal.evidence.map((e) => (
          <div key={e.label} className="flex flex-col gap-0.5 min-w-0">
            <span className="label truncate">{e.label}</span>
            <span className="text-md tabular text-text-primary truncate">{e.value}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-text-secondary">{signal.why}</p>
      <details className="text-xs text-text-secondary">
        <summary className="cursor-pointer select-none">rule</summary>
        <span className="block pt-1">{signal.rule}</span>
      </details>
    </div>
  )
}

export function SignalList({ signals, link = true }: { signals: Signal[]; link?: boolean }) {
  if (signals.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <EmptyBlock label="Nothing unusual right now: no perp is beyond these thresholds." />
        <ul className="px-3 pb-2 text-xs text-text-secondary list-disc list-inside">
          {THRESHOLDS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {signals.map((s) => (
        <SignalCard key={`${s.coin}:${s.kind}`} signal={s} link={link} />
      ))}
    </div>
  )
}
