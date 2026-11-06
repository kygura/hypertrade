import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router'
import { usdShort } from '../../../shared/marketRead'
import type { AssetCtx } from '../../../shared/types'
import { DataTable, type Column } from '../DataTable'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { Caption } from './Caption'
import { movers, oiUsd, pct0, type MoverRow } from './logic'

// MOVERS and AT CAP: the 5 biggest 24h gainers and losers with volume against the
// top-50 median, and the coins Hyperliquid lists at their open-interest cap.

const head = (label: string, title: string) => <span title={title}>{label}</span>

const cols: Column<MoverRow>[] = [
  { key: 'coin', label: head('COIN', 'Hyperliquid perp'), priority: 1, render: (r) => r.coin },
  {
    key: 'chg',
    label: head('24H', 'Mark price change over 24h'),
    priority: 1,
    align: 'right',
    render: (r) => <span className={r.changePct > 0 ? 'text-green' : 'text-red-text'}>{pct0(r.changePct)}</span>,
  },
  {
    key: 'vol',
    label: head('VOLUME', '24h volume as a multiple of the median of the top 50 perps by open interest'),
    priority: 1,
    align: 'right',
    render: (r) => <span className="text-text-secondary">{`${r.volX >= 10 ? r.volX.toFixed(0) : r.volX.toFixed(1)}× med`}</span>,
  },
]

export function Movers({ ctxs, atCap }: { ctxs: AssetCtx[]; atCap: string[] }) {
  const navigate = useNavigate()
  const m = useMemo(() => movers(ctxs), [ctxs])
  const capped = useMemo(() => {
    const byName = new Map(ctxs.map((c) => [c.name, c]))
    return atCap.map((coin) => ({ coin, ctx: byName.get(coin) ?? null }))
  }, [ctxs, atCap])
  const open = (r: { coin: string }) => navigate(`/markets/${encodeURIComponent(r.coin)}`)

  return (
    <Panel>
      <PanelHeader title="MOVERS" />
      <Caption>Biggest 24h moves among perps with at least $1M of OI and volume. Volume is shown against the median perp.</Caption>
      <PanelBody className="p-3 flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1 min-w-0">
            <span className="label px-2">UP</span>
            {m.up.length ? <DataTable columns={cols} rows={m.up} rowKey={(r) => r.coin} onRowClick={open} /> : <p className="px-2 text-xs text-text-secondary">No perp is up on the day.</p>}
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <span className="label px-2">DOWN</span>
            {m.down.length ? <DataTable columns={cols} rows={m.down} rowKey={(r) => r.coin} onRowClick={open} /> : <p className="px-2 text-xs text-text-secondary">No perp is down on the day.</p>}
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <span className="label px-2" title="Hyperliquid's perpsAtOpenInterestCap list">
            AT OI CAP
          </span>
          <p className="px-2 text-xs text-text-secondary">AT OI CAP: new positions can't open, only close.</p>
          {capped.length === 0 ? (
            <p className="px-2 text-xs text-text-secondary">No perp is at its cap right now.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5 px-2">
              {capped.map(({ coin, ctx }) => (
                <Link
                  key={coin}
                  to={`/markets/${encodeURIComponent(coin)}`}
                  className="px-1.5 py-0.5 text-xs bg-amber-bg text-amber hover:underline"
                  title={ctx ? `${coin}: OI ${usdShort(oiUsd(ctx))}` : coin}
                >
                  {coin}
                </Link>
              ))}
            </div>
          )}
        </div>
      </PanelBody>
    </Panel>
  )
}
