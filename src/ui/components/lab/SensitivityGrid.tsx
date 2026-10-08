import { fmtFeature, fmtPctSigned, fmtSigned, parseFeature, SENS_BG, sensitivityTone, type MetricDef, type Rule, type Sensitivity } from '../../lib/lab'

// SensitivityGrid — DESIGN.md §10.9. Per condition, a THRESHOLD row
// (q−0.10 · q−0.05 · BASE · q+0.05 · q+0.10) and a WINDOW row (one cell per
// swapped window, base marked). Each cell prints Sharpe over total return;
// the background ramps by sharpe / base.sharpe, never past pos1.

const SHIFTS = [-0.1, -0.05, 0, 0.05, 0.1] as const

function qLabel(shift: number): string {
  if (shift === 0) return 'BASE'
  return `q${shift > 0 ? '+' : '−'}${Math.abs(shift).toFixed(2)}`
}

function Cell({ label, aria, sharpe, totalReturn, base, isBase }: { label: string; aria: string; sharpe: number | null; totalReturn: number | null; base: number; isBase: boolean }) {
  if (sharpe == null) {
    return (
      <td className="p-1 align-top text-center bg-panel-alt" aria-label={`${aria}: no data`}>
        <span className="block text-[9px] text-text-secondary">{label}</span>
        <span className="text-text-secondary">—</span>
      </td>
    )
  }
  return (
    <td
      className={`p-1 align-top text-center ${SENS_BG[sensitivityTone(sharpe, base)]}`}
      style={isBase ? { boxShadow: 'inset 2px 0 0 var(--color-red-accent)' } : undefined}
      aria-label={`${aria}: sharpe ${fmtSigned(sharpe)}`}
    >
      <span className="block text-[9px] text-text-secondary">{label}</span>
      <span className="block text-sm tabular">{fmtSigned(sharpe)}</span>
      <span className="block text-xs tabular text-text-secondary">{totalReturn == null ? '—' : fmtPctSigned(totalReturn)}</span>
    </td>
  )
}

export function SensitivityGrid({ rule, sensitivity, metrics }: { rule: Rule; sensitivity: Sensitivity; metrics: readonly MetricDef[] }) {
  const base = sensitivity.base
  return (
    <div className="flex flex-col gap-3 p-2">
      {rule.conditions.map((c, i) => {
        const pts = sensitivity.points.filter((p) => p.condition === i)
        const baseWindow = parseFeature(c.feature).window
        const windows = [...new Set([...pts.filter((p) => p.kind === 'window').map((p) => p.shift), ...(baseWindow > 0 ? [baseWindow] : [])])].sort((a, b) => a - b)
        return (
          <table key={i} className="w-full table-fixed border-separate border-spacing-0.5">
            <caption className="text-left text-xs text-text-primary pb-1 tabular">{fmtFeature(c.feature, metrics)}</caption>
            <tbody>
              <tr>
                <th scope="row" className="w-[52px] text-left text-[9px] text-text-secondary font-normal align-middle">
                  THRESHOLD
                </th>
                {SHIFTS.map((s) => {
                  const p = s === 0 ? null : pts.find((x) => x.kind === 'threshold' && Math.abs(x.shift - s) < 1e-9)
                  const aria = s === 0 ? 'threshold base' : `threshold ${s > 0 ? '+' : '−'}${Math.abs(s).toFixed(2)} quantile`
                  return (
                    <Cell
                      key={s}
                      label={qLabel(s)}
                      aria={aria}
                      sharpe={s === 0 ? base.sharpe : (p?.sharpe ?? null)}
                      totalReturn={s === 0 ? base.totalReturn : (p?.totalReturn ?? null)}
                      base={base.sharpe}
                      isBase={s === 0}
                    />
                  )
                })}
              </tr>
              {windows.length > 1 && (
                <tr>
                  <th scope="row" className="text-left text-[9px] text-text-secondary font-normal align-middle">
                    WINDOW
                  </th>
                  {windows.map((w) => {
                    const isBase = w === baseWindow
                    const p = pts.find((x) => x.kind === 'window' && x.shift === w)
                    return (
                      <Cell
                        key={w}
                        label={`w${w}${isBase ? ' BASE' : ''}`}
                        aria={`window ${w}${isBase ? ' (base)' : ''}`}
                        sharpe={isBase ? base.sharpe : (p?.sharpe ?? null)}
                        totalReturn={isBase ? base.totalReturn : (p?.totalReturn ?? null)}
                        base={base.sharpe}
                        isBase={isBase}
                      />
                    )
                  })}
                  {Array.from({ length: Math.max(0, SHIFTS.length - windows.length) }, (_, k) => (
                    <td key={`pad-${k}`} aria-hidden="true" />
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        )
      })}
    </div>
  )
}
