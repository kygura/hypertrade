import { Fragment } from 'react'
import { conditionParts, wireText, type MetricDef, type Rule } from '../lib/lab'

// RuleText — DESIGN.md §10.9/§11. A rule's conditions in our language
// (`z(90) MVRV < −1.12 AND funding ≥ 0.03%`): catalogue display names,
// transform prefixes, thresholds by units, typeset ≥/< and a secondary AND.
// The wire text stays reachable in `title`.

const SIZE = { xs: 'text-xs', sm: 'text-sm', lg: 'text-lg' } as const

export function RuleText({
  rule,
  metrics,
  size = 'sm',
  className = '',
}: {
  rule: Pick<Rule, 'conditions'>
  metrics: readonly MetricDef[]
  size?: 'xs' | 'sm' | 'lg'
  className?: string
}) {
  return (
    <span className={`tabular ${SIZE[size]} ${className}`} title={wireText(rule)}>
      {rule.conditions.map((c, i) => {
        const p = conditionParts(c, metrics)
        return (
          <Fragment key={i}>
            {i > 0 && <span className="text-text-secondary"> AND </span>}
            <span>
              {p.feature} {p.op} {p.threshold}
            </span>
          </Fragment>
        )
      })}
    </span>
  )
}
