import { useNavigate } from 'react-router'
import { fmtUsd, fmtPct } from '../../../shared/format'
import { Button } from '../Button'
import { MomentumBadge } from '../MomentumBadge'
import { SrcTag } from '../SrcTag'
import type { EnrichedSector } from './MindshareGrid'

// SectorDrillPanel — DESIGN.md §10.5. rationale verbatim, sources as
// src-tags, constituent tokens with live OI/funding enrichment.
//
// Deviation from the DESIGN.md sketch: it describes a per-token PRICE/24H%/
// OI/FUNDING table, but GET /api/sectors (src/server/routes/sectors.ts)
// only ever returns SECTOR-level aggregate enrichment (oi_usd_total,
// avg_funding, names_matched) — there is no per-token join and no
// /api/hl/markets endpoint yet to build one client-side. Tokens render as a
// chip list; the aggregate OI/funding/matched-count renders once beneath,
// with the same "absence shown, not hidden" rule when nothing matched.

export function SectorDrillPanel({ sector, onClose }: { sector: EnrichedSector; onClose: () => void }) {
  const navigate = useNavigate()
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
        <div className="flex flex-wrap gap-1.5 mb-2">
          {sector.tokens.map((t) => (
            <button
              key={t}
              onClick={() => navigate(`/markets/${t}`)}
              className="text-[11px] tabular px-1.5 py-0.5 border border-border-subtle text-text-primary hover:bg-hover hover:border-border"
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 text-[11px] tabular">
          <span className="text-text-secondary">
            OI{' '}
            <span className="text-text-primary">
              {sector.names_matched ? fmtUsd(sector.oi_usd_total, { compact: true }) : '—'}
            </span>
          </span>
          <span className="text-text-secondary">
            AVG FUNDING{' '}
            <span className="text-text-primary">
              {sector.names_matched ? fmtPct(sector.avg_funding, { sign: true }) : '—'}
            </span>
          </span>
          <span className="text-text-secondary">
            MATCHED <span className="text-text-primary">{sector.names_matched}/{sector.tokens.length}</span>
          </span>
        </div>
      </div>
    </div>
  )
}
