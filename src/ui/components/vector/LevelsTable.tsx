import { Fragment } from 'react'
import type { Level, LevelStatus } from '../../../shared/vector'
import { fmtSigned } from '../../lib/format'
import { Badge, type Tone } from '../Badge'
import { fmtPrice } from './format'
import { priceDividerIndex } from './scales'

// LevelsTable (hl-cycles DESIGN §14.4.5) — the cost-basis levels as a price
// ladder (high → low) with the live price as a divider row. Status is literal
// (price above / below / crossed recently), so a level above price reads `lost`.

export const LEVELS_TITLE = 'KEY LEVELS · COST-BASIS MAP'

const STATUS_TONE: Record<LevelStatus, Tone> = { holding: 'green', lost: 'red', contested: 'amber' }
// distancePct is already in percent.
const fmtDist = (d: number | null) => fmtSigned(d, '%', 1)

const TD = 'px-[var(--cell-x)] py-[var(--cell-y)]'

export function LevelsTable({ levels, price }: { levels: Level[]; price: number | null }) {
  const sorted = [...levels].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
  const dividerAt = priceDividerIndex(
    sorted.map((l) => l.value),
    price,
  )
  const available = levels.filter((l) => l.value != null).length
  const divider = (
    <tr className="border-y border-text-secondary/40">
      <td colSpan={4} className={`${TD} text-center text-xs text-text-muted tabular`}>
        price {fmtPrice(price)}
      </td>
    </tr>
  )

  return (
    <div className="flex flex-col">
      <div className="table-scroll">
        <table className="w-full text-sm tabular">
          <thead>
            <tr className="text-xs text-text-secondary text-left border-b border-border">
              <th className={`${TD} font-normal`}>Metric</th>
              <th className={`${TD} font-normal text-right`}>Level</th>
              <th className={`${TD} font-normal text-right hidden md:table-cell`}>Distance</th>
              <th className={`${TD} font-normal`}>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((l, i) => (
              <Fragment key={l.key}>
                {i === dividerAt && divider}
                <tr className="border-b border-border-subtle">
                  <td className={`${TD} text-text-muted`}>
                    {l.label}
                    {l.proxy && (
                      <span className="text-text-secondary" title="proxy: flow-weighted ETF cost basis, inflows only">
                        {' '}
                        ~
                      </span>
                    )}
                  </td>
                  <td className={`${TD} text-right text-text-primary whitespace-nowrap`}>
                    {fmtPrice(l.value)}
                    <div className="md:hidden text-xs text-text-secondary">{fmtDist(l.distancePct)}</div>
                  </td>
                  <td className={`${TD} text-right text-text-primary hidden md:table-cell`}>{fmtDist(l.distancePct)}</td>
                  <td className={TD}>{l.status ? <Badge tone={STATUS_TONE[l.status]}>● {l.status}</Badge> : '—'}</td>
                </tr>
              </Fragment>
            ))}
            {price != null && dividerAt === -1 && divider}
          </tbody>
        </table>
      </div>
      {available < 5 && (
        <p className="px-3 py-2 text-xs text-text-secondary">
          {available} of {levels.length} levels available
        </p>
      )}
    </div>
  )
}
