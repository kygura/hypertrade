import { Segmented } from '../Segmented'
import type { ResultsFilterState } from '../../lib/lab'

// ResultsFilters — docs/design/README.md §10.9. Kind, the stats window (where HIT, MAX
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
          { value: 'pairs', label: 'PAIRS', title: 'rules of two or more conditions' },
          { value: 'single', label: 'SINGLE', title: 'rules of one condition' },
        ]}
        value={value.kind}
        onChange={(kind) => set({ kind })}
      />
      <Segmented
        label="stats window"
        options={[
          { value: 'is', label: 'IN-SAMPLE', short: 'IS', title: 'HIT, MAX DD, TR/YR and the filters read the in-sample window: the first 80% of the history, the part the search saw' },
          { value: 'wf', label: 'WALK-FWD', short: 'WF', title: 'HIT, MAX DD, TR/YR and the filters read the walk-forward window: each block scored on what came before it' },
          { value: 'ho', label: 'HOLDOUT', short: 'HO', title: 'HIT, MAX DD, TR/YR and the filters read the holdout: the most recent 20%, never used to pick or rank' },
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
