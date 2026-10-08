import { fmtFeature, type MetricDef } from '../../lib/lab'

// FeatureImportanceList — DESIGN.md §10.9. Top 10 features with a plain CSS
// bar (width = score / max); the printed number is the signal.

export function FeatureImportanceList({ items, metrics }: { items: Array<{ feature: string; score: number }>; metrics: readonly MetricDef[] }) {
  const top = [...items].sort((a, b) => b.score - a.score).slice(0, 10)
  const max = top[0]?.score || 1
  if (top.length === 0) return <p className="px-3 py-3 text-xs text-text-secondary">no feature importance reported</p>
  return (
    <ol className="flex flex-col py-1">
      {top.map((f) => (
        <li key={f.feature} className="grid grid-cols-[minmax(0,1fr)_minmax(60px,40%)_auto] items-center gap-2 px-3 min-h-[var(--row-h)]">
          <span className="text-sm tabular truncate" title={f.feature}>
            {fmtFeature(f.feature, metrics)}
          </span>
          <span aria-hidden="true" className="block h-2">
            <span
              className="block h-2 bg-selected"
              style={{ width: `${Math.max(0, (f.score / max) * 100)}%`, boxShadow: 'inset -1px 0 0 var(--color-info)' }}
            />
          </span>
          <span className="text-xs tabular text-right">{f.score.toFixed(2)}</span>
        </li>
      ))}
    </ol>
  )
}
