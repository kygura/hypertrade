import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import type { PredictedFunding } from '../../../shared/hl-client'
import type { AssetCtx } from '../../../shared/types'
import { DataTable, type Column } from '../DataTable'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { Caption } from './Caption'
import { fundingBoard, pct0, premiumBoard, type FundingRow, type PremiumRow } from './logic'

// FUNDING and BASIS boards: the 5 hottest and 5 coldest funding rates with the CEX
// comparison, and the 5 widest perp-vs-oracle premiums.

const tone = (x: number) => (x > 0 ? 'text-green' : x < 0 ? 'text-red-text' : 'text-text-secondary')
const head = (label: string, title: string) => <span title={title}>{label}</span>

const fundingCols: Column<FundingRow>[] = [
  { key: 'coin', label: head('COIN', 'Hyperliquid perp'), priority: 1, render: (r) => r.coin },
  {
    key: 'apr',
    label: head('HL APR', 'Current hourly funding on Hyperliquid × 8760'),
    priority: 1,
    align: 'right',
    render: (r) => <span className={tone(r.aprPct)}>{pct0(r.aprPct)}</span>,
  },
  {
    key: 'cex',
    label: head('VS CEX', 'Predicted funding on Binance (else Bybit), annualised by its own interval'),
    priority: 1,
    align: 'right',
    render: (r) => (r.cex ? <span className="text-text-secondary" title={r.cex.venue}>{`${pct0(r.cex.aprPct)} ${r.cex.venue === 'Binance' ? 'BIN' : 'BYB'}`}</span> : <span className="text-text-secondary">n/a</span>),
  },
]

const premiumCols: Column<PremiumRow>[] = [
  { key: 'coin', label: head('COIN', 'Hyperliquid perp'), priority: 1, render: (r) => r.coin },
  {
    key: 'bp',
    label: head('PREMIUM', 'Perp mark vs oracle in basis points; positive = perp above spot'),
    priority: 1,
    align: 'right',
    render: (r) => <span className={tone(r.bp)}>{`${r.bp > 0 ? '+' : ''}${r.bp.toFixed(1)} bp`}</span>,
  },
]

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <span className="label px-2">{title}</span>
      {children}
    </div>
  )
}

export function FundingBoard({ ctxs, predicted }: { ctxs: AssetCtx[]; predicted: Map<string, PredictedFunding[]> }) {
  const navigate = useNavigate()
  const { hot, cold } = useMemo(() => fundingBoard(ctxs, predicted), [ctxs, predicted])
  const open = (r: { coin: string }) => navigate(`/markets/${encodeURIComponent(r.coin)}`)
  return (
    <Panel>
      <PanelHeader title="FUNDING" />
      <Caption>Funding is what one side pays the other every hour. Large positive = longs crowded; large negative = shorts crowded.</Caption>
      <PanelBody className="p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <Sub title="HIGHEST APR">
          <DataTable columns={fundingCols} rows={hot} rowKey={(r) => r.coin} onRowClick={open} />
        </Sub>
        <Sub title="LOWEST APR">
          <DataTable columns={fundingCols} rows={cold} rowKey={(r) => r.coin} onRowClick={open} />
        </Sub>
      </PanelBody>
    </Panel>
  )
}

export function PremiumBoard({ ctxs }: { ctxs: AssetCtx[] }) {
  const navigate = useNavigate()
  const rows = useMemo(() => premiumBoard(ctxs), [ctxs])
  return (
    <Panel>
      <PanelHeader title="BASIS" />
      <Caption>Premium = perp mark vs oracle (spot index). Above spot: leveraged buyers are leading.</Caption>
      <PanelBody className="p-3">
        <DataTable columns={premiumCols} rows={rows} rowKey={(r) => r.coin} onRowClick={(r) => navigate(`/markets/${encodeURIComponent(r.coin)}`)} />
      </PanelBody>
    </Panel>
  )
}
