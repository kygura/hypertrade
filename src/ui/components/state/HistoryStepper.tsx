import { Button } from '../Button'

// HistoryStepper — DESIGN.md §10.6. ◂/▸ ghost buttons around a date
// <select>. Dates come from GET /api/marketstate's `history` field (server-
// backed, per the actual routes/marketstate.ts contract) rather than a
// build-time import.meta.glob.

export function HistoryStepper({
  dates,
  current,
  onChange,
}: {
  dates: string[]
  current: string
  onChange: (date: string) => void
}) {
  const sorted = [...dates].sort()
  const idx = sorted.indexOf(current)

  return (
    <div className="flex items-center gap-1.5">
      <Button tier="ghost" disabled={idx <= 0} onClick={() => onChange(sorted[idx - 1])}>
        ◂
      </Button>
      <select value={current} onChange={(e) => onChange(e.target.value)} className="text-[11px] h-[var(--control-md)]">
        {sorted.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <Button tier="ghost" disabled={idx === -1 || idx >= sorted.length - 1} onClick={() => onChange(sorted[idx + 1])}>
        ▸
      </Button>
    </div>
  )
}
