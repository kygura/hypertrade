import { Segmented } from '../Segmented'
import type { ResultsFilterState } from '../../lib/lab'

// ResultsFilters — DESIGN.md §10.9. Kind, the stats window (where HIT, MAX
// DD, TR/YR and the numeric filters read from; the two Sharpe cells ignore
// it), and blank-is-off numeric filters. No control sorts by holdout.

export function ResultsFilters({
  value,
  onChange,
  shown,
  total,
}: {
  value: ResultsFilterState
  onChange: (v: ResultsFilterState) => void
  shown: number
  total: number
}) {
  const set = (patch: Partial<ResultsFilterState>) => onChange({ ...value, ...patch })
  const numInput = (key: 'minSharpe' | 'maxDd' | 'minHit', label: string, placeholder: string) => (
    <label className="flex items-center gap-1.5">
      <span className="label whitespace-nowrap">{label}</span>
      <input
        value={value[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        inputMode="decimal"
        placeholder={placeholder}
        className="w-[7ch]"
      />
    </label>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-b border-border-subtle">
      <Segmented
        label="rule kind"
        options={[
          { value: 'all', label: 'ALL' },
          { value: 'pairs', label: 'PAIRS' },
          { value: 'single', label: 'SINGLE' },
        ]}
        value={value.kind}
        onChange={(kind) => set({ kind })}
      />
      <Segmented
        label="stats window"
        options={[
          { value: 'is', label: 'IS', title: 'in-sample' },
          { value: 'wf', label: 'WF', title: 'walk-forward' },
          { value: 'ho', label: 'HO', title: 'holdout' },
        ]}
        value={value.window}
        onChange={(window) => set({ window })}
      />
      {numInput('minSharpe', 'MIN SHARPE', '1.0')}
      {numInput('maxDd', 'MAX DD', '−30%')}
      {numInput('minHit', 'MIN HIT', '50%')}
      <span className="ml-auto text-xs text-text-secondary tabular">
        {shown} OF {total} RULES
      </span>
    </div>
  )
}
