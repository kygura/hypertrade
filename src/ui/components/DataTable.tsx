import { useMemo, useState, type ReactNode } from 'react'

// DataTable — DESIGN.md §4.4/§11. Priority-column drop mechanism via
// hidden md:table-cell / hidden lg:table-cell — no JS column manager.
// Wrap in .table-scroll so a wide table scrolls inside its panel, never the
// page. Row height comes from --row-h (density var); rows are focusable so
// Enter can activate the row's drill-in (§8 keyboard).

export interface Column<T> {
  key: string
  label: ReactNode
  priority: 1 | 2 | 3 | 4
  align?: 'left' | 'right'
  render: (row: T) => ReactNode
  /** Raw sort key for this column; columns without one are not clickable-sortable. */
  sortValue?: (row: T) => number | string
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
  isSelected,
  emptyLabel,
  sortable,
  defaultSort,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  /** Marks a row selected: bg-selected + aria-selected. */
  isSelected?: (row: T) => boolean
  emptyLabel?: ReactNode
  sortable?: boolean
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
}) {
  const [sort, setSort] = useState(defaultSort ?? null)

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a)
      const bv = col.sortValue!(b)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return 0
    })
  }, [rows, sort, columns])

  if (rows.length === 0 && emptyLabel) return <>{emptyLabel}</>

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))

  return (
    <div className="table-scroll">
      <table className="dt w-full text-[11px] tabular border-collapse">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col) => {
              const canSort = sortable && col.sortValue
              const active = sort?.key === col.key
              return (
                <th
                  key={col.key}
                  onClick={canSort ? () => toggleSort(col.key) : undefined}
                  className={`px-2 py-1.5 label ${col.align === 'right' ? 'text-right' : 'text-left'} ${priorityClass(col.priority)} ${
                    canSort ? 'cursor-pointer select-none hover:text-text-primary' : ''
                  } ${active ? 'text-text-primary' : ''}`}
                >
                  {col.label}
                  {active && (sort!.dir === 'desc' ? ' ▾' : ' ▴')}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr
              key={rowKey(row)}
              className={`border-b border-border-subtle ${onRowClick ? 'cursor-pointer hover:bg-hover' : ''} ${isSelected?.(row) ? 'bg-selected' : ''}`}
              aria-selected={isSelected ? isSelected(row) : undefined}
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
