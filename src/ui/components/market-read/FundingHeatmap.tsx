import { useMemo } from 'react'
import { Link } from 'react-router'
import type { AssetCtx } from '../../../shared/types'
import { useNow } from '../../lib/hooks'
import { useFundingGrid } from '../../lib/hlLive'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { ErrorBlock, SkeletonRows } from '../state'
import { Caption } from './Caption'
import { BASELINE_APR, heatColor, heatGrid, pct0, topByOi } from './logic'

// FUNDING HEATMAP — coin × hour, the last 72 hourly settlements of the top 20 coins by OI,
// annualised. Rows by current APR. The grid scrolls inside the panel on narrow screens.

const COINS = 20
const HOURS = 72

const stamp = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function FundingHeatmap({ ctxs }: { ctxs: AssetCtx[] }) {
  const now = useNow(60_000)
  const top = useMemo(() => topByOi(ctxs, COINS), [ctxs])
  // Sorted so a reshuffle inside the top 20 does not refetch.
  const coins = useMemo(() => top.map((c) => c.name).sort(), [top])
  const grid = useFundingGrid(coins, HOURS)
  const g = useMemo(() => heatGrid(top, grid.data, now, HOURS), [top, grid.data, now])
  const template = `56px repeat(${HOURS}, minmax(7px, 1fr))`

  return (
    <Panel>
      <PanelHeader title="FUNDING HEATMAP">
        <span className="text-xs text-text-secondary tabular">{`${g.rows.length}/${coins.length} COINS · ${HOURS}H`}</span>
      </PanelHeader>
      <Caption>
        Each cell is one hourly funding payment, annualised. Grey is HL's baseline (+11% APR, what a perp pays when it tracks spot). Warm = longs paying above that, cool = below it or shorts paying. A band that lasts for days marks a crowded side.
      </Caption>
      <PanelBody className="p-3">
        {g.rows.length === 0 ? (
          grid.loading ? (
            <SkeletonRows rows={6} />
          ) : (
            <ErrorBlock message={grid.error ? `Funding history unavailable (${grid.error})` : 'No funding history returned for these coins.'} />
          )
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[560px] flex flex-col gap-px">
              {g.rows.map((r) => (
                <div key={r.coin} className="grid gap-px items-center" style={{ gridTemplateColumns: template }}>
                  <Link to={`/markets/${encodeURIComponent(r.coin)}`} className="text-xs text-text-primary truncate pr-1 hover:underline" title={`${r.coin} now ${pct0(r.aprNow)} APR`}>
                    {r.coin}
                  </Link>
                  {r.cells.map((v, i) => (
                    <span
                      key={g.cols[i]}
                      className="h-3.5"
                      style={{ background: heatColor(v) }}
                      title={v == null ? `${r.coin} · ${stamp(g.cols[i]!)} · no settlement` : `${r.coin} · ${stamp(g.cols[i]!)} · ${pct0(v)} APR`}
                    />
                  ))}
                </div>
              ))}
              <div className="grid text-2xs text-text-secondary pt-1" style={{ gridTemplateColumns: template }}>
                <span />
                <span style={{ gridColumn: '2 / span 24' }}>{`−${HOURS}h`}</span>
                <span style={{ gridColumn: '26 / span 24' }}>−48h</span>
                <span style={{ gridColumn: '50 / span 24' }} className="flex justify-between">
                  <span>−24h</span>
                  <span>now</span>
                </span>
              </div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 pt-2 text-2xs text-text-secondary tabular">
          <span>{pct0(BASELINE_APR - 60)}</span>
          <span className="h-2 w-32" style={{ background: `linear-gradient(to right, ${heatColor(BASELINE_APR - 60)}, ${heatColor(BASELINE_APR - 20)}, var(--color-elevated), ${heatColor(BASELINE_APR + 20)}, ${heatColor(BASELINE_APR + 60)})` }} />
          <span>{`${pct0(BASELINE_APR + 60)} APR`}</span>
          {grid.loading && g.rows.length > 0 && <span>· loading {coins.length - g.rows.length} more</span>}
        </div>
      </PanelBody>
    </Panel>
  )
}
