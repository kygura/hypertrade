import type { VectorResponse } from '../../../shared/vector'
import { fmtAge } from '../../lib/format'
import { StatusDot } from '../Badge'
import { Caret } from './Caret'
import { LABEL } from './format'

// SourcesFooter (hl-cycles DESIGN §14.4.8) — per-source health behind the
// Vector payload, collapsed to one line. Nothing else changes colour because of
// a failing source; the hero's stale strip already carries that consequence.

export function SourcesFooter({ sources, now }: { sources: VectorResponse['sources']; now: number }) {
  const rows = Object.entries(sources)
  const failing = rows.filter(([, s]) => s.lastError != null).length
  return (
    <details className="group panel">
      <summary className={`${LABEL} list-none cursor-pointer select-none flex items-center gap-1 px-3 min-h-[var(--tap-min)] py-1.5 hover:text-text-primary`}>
        <Caret /> sources · {rows.length - failing} ok
        {failing > 0 && <span className="text-red-text"> · {failing} failing</span>}
      </summary>
      <div className="table-scroll">
        <table className="w-full text-sm tabular">
          <thead>
            <tr className="text-xs text-text-secondary text-left border-y border-border">
              <th className="font-normal px-3 py-1">source</th>
              <th className="font-normal px-3 py-1">last ok</th>
              <th className="font-normal px-3 py-1">error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, s]) => (
              <tr key={name} className="border-b border-border-subtle">
                <td className="px-3 py-[var(--cell-y)] whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot status={s.lastError == null ? 'ok' : 'down'} />
                    <span className={s.lastError == null ? 'text-text-muted' : 'text-red-text'}>{s.lastError == null ? 'ok' : 'failing'}</span>
                    <span className="text-text-primary">· {name}</span>
                  </span>
                </td>
                <td className="px-3 py-[var(--cell-y)] text-text-secondary whitespace-nowrap">
                  {s.lastOk == null ? '—' : fmtAge(new Date(s.lastOk).toISOString(), now)}
                </td>
                <td className="px-3 py-[var(--cell-y)] text-text-muted whitespace-normal break-words">{s.lastError ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
