import { fmtTs } from '../strategy/format'
import { fmtMdHm } from './format'

// ResultTable — DESIGN-terminal §6.2. Columns come from the response, so
// priority hiding does not apply: the §4.4 escape hatch (.table-scroll,
// sticky first column, sticky header). Numbers right-aligned tabular;
// timestamps `MM-DD HH:mm` UTC with the full stamp as title.

type Cell = string | number | null

const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

export function fmtCell(v: Cell): { text: string; title?: string; numeric: boolean } {
  if (v == null) return { text: '—', numeric: false }
  if (typeof v === 'number') return { text: Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(8))), numeric: true }
  if (ISO_TS.test(v)) return { text: fmtMdHm(v), title: fmtTs(v), numeric: false }
  return { text: v, numeric: false }
}

const STICKY_COL = 'sticky left-0 z-[1] bg-panel'

export function ResultTable({ columns, rows }: { columns: string[]; rows: Cell[][] }) {
  return (
    <div className="table-scroll max-h-[70vh] overflow-y-auto">
      <table className="dt w-full text-sm tabular border-collapse">
        <thead className="sticky top-0 z-[2] bg-panel">
          <tr className="border-b border-border">
            {columns.map((c, i) => (
              <th key={`${c}-${i}`} scope="col" className={`px-2 py-1.5 label text-left whitespace-nowrap ${i === 0 ? STICKY_COL : ''}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="border-b border-border-subtle" style={{ height: 'var(--row-h)' }}>
              {columns.map((_, i) => {
                const cell = fmtCell(row[i] ?? null)
                return (
                  <td
                    key={i}
                    title={cell.title}
                    className={`px-2 whitespace-nowrap ${cell.numeric ? 'text-right' : 'text-left'} ${i === 0 ? `${STICKY_COL} text-text-primary` : ''}`}
                  >
                    {cell.text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
