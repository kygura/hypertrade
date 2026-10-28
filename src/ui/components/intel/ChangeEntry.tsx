import type { WatchChange } from '../../../shared/intel'
import { fmtTs } from '../strategy/format'
import { ClaimAge } from './ClaimAge'
import { ClaimList } from './ClaimList'
import { diffLineKind } from './watch'

// ChangeEntry — DESIGN-terminal §8.2. One detected change: time + age; the
// model's summary as claim lines; code-computed facts as plain rows; the line
// diff (URL watches) behind a `▸ DIFF (n lines)` disclosure, `+` green-text /
// `−` red-text with the signs printed, max 320px with internal scroll; and the
// assets the mapper alerted as tags.

const LINE_CLASS = { add: 'text-green', del: 'text-red-text', ctx: 'text-text-secondary' } as const

export function ChangeEntry({ change }: { change: WatchChange }) {
  const lines = change.diff ? change.diff.replace(/\n$/, '').split('\n') : []
  return (
    <article aria-label={`Change detected ${fmtTs(change.ts)}`} className="flex flex-col gap-2 py-3 border-b border-border-subtle last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 text-xs tabular text-text-secondary">
        <span>{fmtTs(change.ts)}</span>
        <span aria-hidden="true">·</span>
        <ClaimAge ts={change.ts} />
      </div>
      {change.lines.length > 0 && <ClaimList claims={change.lines} />}
      {change.facts.length > 0 && (
        <ul aria-label="detected facts" className="flex flex-col gap-0.5">
          {change.facts.map((f, i) => (
            <li key={i} className="text-sm tabular text-text-primary break-words">
              {f}
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <details className="group">
          <summary className="label cursor-pointer list-none min-h-[var(--tap-min)] inline-flex items-center hover:text-text-primary">
            <span aria-hidden="true" className="group-open:hidden">
              ▸&nbsp;
            </span>
            <span aria-hidden="true" className="hidden group-open:inline">
              ▾&nbsp;
            </span>
            DIFF ({lines.length} {lines.length === 1 ? 'line' : 'lines'})
          </summary>
          <pre className="mt-1 text-sm leading-snug max-h-[320px] overflow-auto bg-panel-alt border border-border-subtle p-2 whitespace-pre-wrap break-words">
            {lines.map((l, i) => {
              const k = diffLineKind(l)
              const body = k === 'ctx' ? l : l.slice(1)
              const sign = k === 'add' ? '+' : k === 'del' ? '−' : ' '
              return (
                <span key={i} className={`block ${LINE_CLASS[k]}`}>
                  {k !== 'ctx' && <span className="sr-only">{k === 'add' ? 'added: ' : 'removed: '}</span>}
                  {k === 'ctx' ? body : `${sign}${body}`}
                </span>
              )
            })}
          </pre>
        </details>
      )}
      {change.alertedAssets.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="alerted assets">
          {change.alertedAssets.map((a) => (
            <span key={a} className="src-tag">
              ALERTED {a}
            </span>
          ))}
        </div>
      )}
    </article>
  )
}
