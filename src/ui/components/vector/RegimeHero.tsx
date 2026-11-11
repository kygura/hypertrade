import type { VectorResponse } from '../../../shared/vector'
import { PHASE_LABEL, PHASE_VAR } from '../cycles/format'
import type { CyclePhase } from '../../../shared/cycles'
import { Caret } from './Caret'
import { LABEL, daysBetween, fmtDate, fmtRaw } from './format'
import { REGIME_WORD, regimeColor } from './scales'

// RegimeHero (hl-cycles DESIGN §14.4.1): the regime word, the BTC/cash
// allocation, since when, inputs as-of, the HTF-phase disagreement note,
// confirm / invalidate triggers and the stress conditions behind the state.

// regime.htfNote is written server-side; the UI only colours the phase word in it.
const PHASE_WORD = /\b(ACCUMULATION|EXPANSION|EUPHORIA|DISTRIBUTION|MARKDOWN|CAPITULATION)\b/

function HtfNote({ note }: { note: string }) {
  const m = PHASE_WORD.exec(note)
  if (!m) return <>{note}</>
  const phase = m[1]!.toLowerCase() as CyclePhase
  return (
    <>
      {note.slice(0, m.index)}
      <span className="tabular" style={{ color: `var(${PHASE_VAR[phase]})` }}>
        {PHASE_LABEL[phase]}
      </span>
      {note.slice(m.index + m[1]!.length)}
    </>
  )
}

export function RegimeHero({
  regime,
  asOf,
  oldestInputAsOf,
  brief,
}: {
  regime: VectorResponse['regime']
  asOf: number | null
  oldestInputAsOf: number | null
  brief: VectorResponse['brief']
}) {
  const color = regimeColor(regime.state)
  const alloc = regime.allocation
  const active = regime.conditions.filter((c) => c.on).length

  return (
    <div className="flex flex-col gap-2 p-3 border-l-[3px]" style={{ borderLeftColor: regime.state ? color : 'var(--color-border)' }}>
      <div className="text-xl leading-none tabular tracking-[0.02em]" style={{ color }}>
        {regime.state ? REGIME_WORD[regime.state] : '—'}
      </div>
      {regime.state == null && <div className="text-base text-text-muted">insufficient history</div>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base tabular">
        <span className="text-text-primary">{alloc == null ? '—' : `${Math.round(alloc)}% BTC`}</span>
        <span
          className="relative inline-block w-40 max-w-full h-2 bg-border"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={alloc ?? undefined}
          aria-valuetext={alloc == null ? 'allocation unavailable' : `${Math.round(alloc)}% BTC`}
        >
          {alloc != null && <span className="absolute inset-y-0 left-0" style={{ width: `${Math.min(100, Math.max(0, alloc))}%`, background: color }} />}
        </span>
        {alloc != null && <span className="text-sm text-text-secondary">· {Math.round(100 - alloc)}% cash</span>}
      </div>
      <div className="flex flex-col gap-0.5 text-sm tabular">
        <span className="text-text-muted">
          {regime.since == null ? 'since —' : `since ${fmtDate(regime.since)}${asOf == null ? '' : ` · day ${daysBetween(regime.since, asOf)}`}`}
        </span>
        <span className="text-text-secondary">inputs as of {fmtDate(oldestInputAsOf)}</span>
      </div>
      {regime.htfNote && (
        <p className="text-base text-text-muted">
          <HtfNote note={regime.htfNote} />
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 items-baseline">
        <dt className={LABEL}>Confirm</dt>
        <dd className="text-base text-text-muted">{brief.confirm ?? '—'}</dd>
        <dt className={LABEL}>Invalidate</dt>
        <dd className="text-base text-text-muted">{brief.invalidate ?? '—'}</dd>
      </dl>
      {regime.conditions.length > 0 && (
        <details className="group">
          <summary className={`${LABEL} cursor-pointer list-none select-none min-h-[var(--tap-min)] flex items-center gap-1 hover:text-text-primary`}>
            <Caret />
            stress conditions · <span className={active > 0 ? 'text-red-text' : undefined}>{active}</span> of {regime.conditions.length} active
          </summary>
          <div className="table-scroll">
            <table className="w-full text-sm tabular">
              <tbody>
                {regime.conditions.map((c) => (
                  <tr key={c.key} className="border-b border-border-subtle">
                    <td className="py-[var(--cell-y)] pr-2 whitespace-nowrap">
                      <span className={c.on ? 'text-red-text' : 'text-text-secondary'}>● {c.on ? 'active' : 'clear'}</span>
                    </td>
                    <td className="py-[var(--cell-y)] pr-2 text-text-muted">{c.label}</td>
                    <td className="py-[var(--cell-y)] pr-2 text-right text-text-primary">{fmtRaw(c.value)}</td>
                    <td className="py-[var(--cell-y)] text-right text-text-secondary hidden md:table-cell">{fmtDate(c.asOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  )
}
