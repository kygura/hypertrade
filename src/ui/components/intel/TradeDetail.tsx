import type { ReactNode } from 'react'
import type { Trade, TradeNote } from '../../../shared/intel'
import { classForPnl } from '../../../shared/format'
import { SrcTag } from '../SrcTag'
import { fmtTs } from '../strategy/format'
import { ClaimLine } from './ClaimLine'
import { fmtHold, fmtPctNum, fmtSignedNum, fmtUsdSigned2 } from './format'
import { NoteEditor } from './NoteEditor'
import { RCell, SideWord, fmtExcursion } from './TradesTable'

// TradeDetail — DESIGN-terminal §4.2. The selected trade: id, every table
// field as label/value pairs (what a narrow screen dropped), the entry state
// (computed values, plain), its tag, the NoteEditor, and the model's note
// summary as a ClaimLine when present.

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="label text-[10px]">{label}</dt>
      <dd className="text-[12px] tabular text-text-primary text-right min-w-0 break-words">{children}</dd>
    </div>
  )
}

const px = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 6 }))

export function entryStateText(s: Trade['entryState']): string {
  const z = (v: number | null) => (v == null ? '—' : fmtSignedNum(v, 1))
  return `FUNDING z ${z(s.fundingZ)} · OI z ${z(s.oiZ)} · 24H ${fmtPctNum(s.change24hPct, 1)}`
}

export function TradeDetail({ trade, onNoteSaved }: { trade: Trade; onNoteSaved: (n: TradeNote) => void }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] text-text-secondary truncate" title={trade.id}>
          {trade.id}
        </span>
      </div>
      <dl className="flex flex-col">
        <Row label="COIN">
          <span className="inline-flex items-center gap-1.5">
            {trade.asset} <SrcTag source={trade.venue} />
          </span>
        </Row>
        <Row label="SIDE">
          <SideWord side={trade.side} />
        </Row>
        <Row label="R">
          <RCell r={trade.r} />
        </Row>
        <Row label="PNL">
          <span className={classForPnl(trade.pnlUsd)}>{fmtUsdSigned2(trade.pnlUsd)}</span>
        </Row>
        <Row label="FEES">{fmtUsdSigned2(-Math.abs(trade.feesUsd))}</Row>
        <Row label="OPENED">{fmtTs(trade.openedAt)}</Row>
        <Row label="CLOSED">{trade.closedAt ? fmtTs(trade.closedAt) : <span className="text-amber">OPEN</span>}</Row>
        <Row label="HOLD">{fmtHold(trade.holdMs)}</Row>
        <Row label="SESSION">{trade.session.toUpperCase()}</Row>
        <Row label="SIZE">{px(trade.size)}</Row>
        <Row label="ENTRY / EXIT">
          {px(trade.entryPx)} / {px(trade.exitPx)}
        </Row>
        <Row label="STOP">{px(trade.stopPx)}</Row>
        <Row label="MAE/MFE">{fmtExcursion(trade)}</Row>
      </dl>
      <div className="flex flex-col gap-1">
        <span className="label text-[10px]">ENTRY STATE</span>
        <span className="text-[12px] tabular text-text-primary">{entryStateText(trade.entryState)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="label text-[10px]">TAG</span>
        {trade.tag ? <span className="src-tag">{trade.tag}</span> : <span className="text-[12px] text-text-secondary">—</span>}
      </div>
      <NoteEditor key={trade.id} tradeId={trade.id} note={trade.note} onSaved={onNoteSaved} />
      {trade.noteSummary && <ClaimLine claim={trade.noteSummary} />}
    </div>
  )
}
