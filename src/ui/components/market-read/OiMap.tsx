import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { ResponsiveContainer, Treemap } from 'recharts'
import { usdShort } from '../../../shared/marketRead'
import type { AssetCtx } from '../../../shared/types'
import { useMedia } from '../../lib/hooks'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { Caption } from './Caption'
import { changeColor, oiUsd, pct0, topByOi } from './logic'

// OI MAP — open interest now (HL publishes no OI history): a treemap of the top 40 coins
// by OI in USD, coloured by 24h change. Below 640px a ranked bar list instead.

const TOP = 40
const LIST_TOP = 20
const SM = '(min-width: 640px)'

interface Tile {
  name: string
  size: number
  chg: number
}

interface TileProps {
  x?: number
  y?: number
  width?: number
  height?: number
  depth?: number
  name?: string
  chg?: number
  size?: number
  onPick?: (coin: string) => void
}

function TileShape({ x = 0, y = 0, width = 0, height = 0, depth, name, chg = 0, size = 0, onPick }: TileProps) {
  if (depth !== 1 || !name) return null
  const label = width > 34 && height > 16
  const sub = width > 76 && height > 32
  return (
    <g onClick={() => onPick?.(name)} className="cursor-pointer">
      <title>{`${name}: OI ${usdShort(size)}, 24h ${pct0(chg)}`}</title>
      <rect x={x} y={y} width={width} height={height} style={{ fill: changeColor(chg), stroke: 'var(--color-panel)', strokeWidth: 1 }} />
      {label && (
        <text x={x + 4} y={y + 13} style={{ fill: 'var(--color-text-primary)', fontSize: 'var(--text-sm)' }}>
          {name}
        </text>
      )}
      {sub && (
        <text x={x + 4} y={y + 26} style={{ fill: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
          {`${usdShort(size)} ${pct0(chg)}`}
        </text>
      )}
    </g>
  )
}

export function OiMap({ ctxs }: { ctxs: AssetCtx[] }) {
  const navigate = useNavigate()
  const wide = useMedia(SM)
  const tiles = useMemo<Tile[]>(() => topByOi(ctxs, TOP).map((c) => ({ name: c.name, size: oiUsd(c), chg: c.dayChange * 100 })), [ctxs])
  const open = (coin: string) => navigate(`/markets/${encodeURIComponent(coin)}`)
  const max = tiles[0]?.size ?? 1

  return (
    <Panel>
      <PanelHeader title="OI MAP" />
      <Caption>
        Where the money is now: tile size = open positions in USD, colour = 24h price change. Hyperliquid publishes no OI history, so this is a snapshot, not a trend.
      </Caption>
      <PanelBody className="p-3">
        {wide ? (
          <div className="h-[340px]">
            <ResponsiveContainer width="100%" height="100%">
              <Treemap data={tiles} dataKey="size" nameKey="name" isAnimationActive={false} content={<TileShape onPick={open} />} />
            </ResponsiveContainer>
          </div>
        ) : (
          <ol className="flex flex-col gap-1">
            {tiles.slice(0, LIST_TOP).map((t, i) => (
              <li key={t.name}>
                <button type="button" onClick={() => open(t.name)} className="w-full grid grid-cols-[20px_56px_1fr_52px_44px] items-center gap-2 text-sm tabular text-left">
                  <span className="text-text-secondary">{i + 1}</span>
                  <span className="text-text-primary truncate">{t.name}</span>
                  <span className="h-3 bg-elevated">
                    <span className="block h-full" style={{ width: `${Math.max(2, (t.size / max) * 100)}%`, background: changeColor(t.chg) }} />
                  </span>
                  <span className="text-right text-text-primary">{usdShort(t.size)}</span>
                  <span className={`text-right ${t.chg > 0 ? 'text-green' : t.chg < 0 ? 'text-red-text' : 'text-text-secondary'}`}>{pct0(t.chg)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </PanelBody>
    </Panel>
  )
}
