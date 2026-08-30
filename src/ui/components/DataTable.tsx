import type { ReactNode } from 'react'

// DataTable — DESIGN.md §4.4/§11. Priority-column drop mechanism via
// hidden md:table-cell / hidden lg:table-cell — no JS column manager.
// Wrap in .table-scroll so a wide table scrolls inside its panel, never the
// page. Row height comes from --row-h (density var); rows are focusable so
// Enter can activate the row's drill-in (§8 keyboard).

export interface Column<T> {
  key: string
  label: string
  priority: 1 | 2 | 3 | 4
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
}

function priorityClass(priority: 1 | 2 | 3 | 4): string {
  if (priority >= 4) return 'hidden lg:table-cell'
  if (priority >= 3) return 'hidden md:table-cell'
  return ''
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyLabel,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  emptyLabel?: ReactNode
}) {
  if (rows.length === 0 && emptyLabel) return <>{emptyLabel}</>

  return (
    <div className="table-scroll">
      <table className="w-full text-[11px] tabular border-collapse">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-2 py-1.5 label ${col.align === 'right' ? 'text-right' : 'text-left'} ${priorityClass(col.priority)}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={`border-b border-border-subtle ${onRowClick ? 'cursor-pointer hover:bg-hover' : ''}`}
              style={{ height: 'var(--row-h)' }}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter') onRowClick(row)
                    }
                  : undefined
              }
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-2 ${col.align === 'right' ? 'text-right' : 'text-left'} ${priorityClass(col.priority)}`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
