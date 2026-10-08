import { conditionMet, fmtFeature, fmtFeatureValue, type MetricDef, type RuleEvaluation } from '../../lib/lab'

// LatestValuesRow — DESIGN.md §10.9. One row per condition: the feature's
// latest value against its threshold, ✓/✗ with the word in title and
// visually-hidden text. A null value prints `— no data` and grays the row.

export function LatestValuesRow({ ev, metrics }: { ev: RuleEvaluation; metrics: readonly MetricDef[] }) {
  return (
    <table className="w-full text-sm tabular">
      <tbody>
        {ev.rule.conditions.map((c, i) => {
          const v = ev.latest.values[c.feature]
          const met = conditionMet(c, v)
          const word = met == null ? 'no data' : met ? 'MET' : 'NOT MET'
          return (
            <tr key={i} className={`border-b border-border-subtle ${met == null ? 'text-text-secondary' : ''}`} style={{ height: 'var(--row-h)' }}>
              <th scope="row" className="px-3 text-left font-normal">
                {fmtFeature(c.feature, metrics)}
              </th>
              <td className="px-1 text-right text-text-primary">{v == null ? '—' : fmtFeatureValue(c.feature, v, metrics)}</td>
              <td className="px-1 text-center text-text-secondary">{c.op === '<' ? '<' : '≥'}</td>
              <td className="px-1 text-right">{fmtFeatureValue(c.feature, c.threshold, metrics)}</td>
              <td className="px-3 text-right" title={word}>
                {met == null ? (
                  <span className="text-xs">no data</span>
                ) : (
                  <>
                    <span aria-hidden="true" className={met ? 'text-green' : 'text-text-secondary'}>
                      {met ? '✓' : '✗'}
                    </span>
                    <span className="sr-only">{word}</span>
                  </>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
