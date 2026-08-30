import { useNavigate } from 'react-router'
import { fmtUsd, fmtPct, fmtPrice, classForPnl } from '../../../shared/format'
import { Button } from '../Button'
import { MomentumBadge } from '../MomentumBadge'
import { SrcTag } from '../SrcTag'
import { DataTable, type Column } from '../DataTable'
import type { EnrichedSector, SectorTokenRow } from './MindshareGrid'

// SectorDrillPanel — DESIGN.md §10.5. rationale verbatim, sources as
// src-tags, constituent tokens as a DataTable (TOKEN/PRICE/24H%/OI/FUNDING,
// same §4.4 drop order as Markets) built from GET /api/sectors's per-token
// enrichment. Tokens with no HL listing (not in tokenRows) render as plain
// chips below the table — absence shown, not hidden.

export function SectorDrillPanel({ sector, onClose }: { sector: EnrichedSector; onClose: () => void }) {
  const navigate = useNavigate()
  const matchedCoins = new Set(sector.tokenRows.map((r) => r.coin))
  const unmatched = sector.tokens.filter((t) => !matchedCoins.has(t))

  const columns: Column<SectorTokenRow>[] = [
    { key: 'coin', label: 'TOKEN', priority: 1, sortValue: (r) => r.coin, render: (r) => r.coin },
    {
      key: 'price',
      label: 'PRICE',
      priority: 1,
      align: 'right',
      sortValue: (r) => r.markPx,
      render: (r) => fmtPrice(r.markPx),
    },
    {
      key: 'chg',
      label: '24H%',
      priority: 2,
      align: 'right',
      sortValue: (r) => r.dayChangePct,
      render: (r) => (
        <span className={classForPnl(r.dayChangePct)}>
          {fmtPct(r.dayChangePct, { sign: true })} {r.dayChangePct >= 0 ? '▲' : '▼'}
        </span>
      ),
    },
    {
      key: 'oi',
      label: 'OI',
      priority: 3,
      align: 'right',
      sortValue: (r) => r.openInterestUsd,
      render: (r) => fmtUsd(r.openInterestUsd, { compact: true }),
    },
    {
      key: 'funding',
      label: 'FUNDING',
      priority: 4,
      align: 'right',
      sortValue: (r) => r.funding,
      render: (r) => <span className={classForPnl(r.funding)}>{fmtPct(r.funding, { decimals: 4, sign: true })}</span>,
    },
  ]

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] uppercase text-text-primary">{sector.label}</span>
          <MomentumBadge momentum={sector.momentum} />
        </div>
        <Button tier="ghost" onClick={onClose}>
          CLOSE ✕
        </Button>
      </div>

      <p className="text-[13px] text-text-muted">{sector.rationale}</p>

      <div className="flex flex-wrap gap-1.5">
        {sector.sources.map((s) => (
          <span key={s} className="src-tag">
            {s}
          </span>
        ))}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="label">TOKENS</span>
          <SrcTag source="hl" />
        </div>
        {sector.tokenRows.length > 0 && (
          <DataTable
            columns={columns}
            rows={sector.tokenRows}
            rowKey={(r) => r.coin}
            onRowClick={(r) => navigate(`/markets/${r.coin}`)}
          />
        )}
        {unmatched.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {unmatched.map((t) => (
              <span key={t} className="text-[11px] tabular px-1.5 py-0.5 border border-border-subtle text-text-secondary">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
