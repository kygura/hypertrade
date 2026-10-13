import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { OrderPreview } from '../../../shared/intel'
import { Badge, type Tone } from '../Badge'
import { Button } from '../Button'
import { LabWarnings } from '../LabWarnings'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { ClaimLine } from './ClaimLine'
import { VenueBadge } from './VenueBadge'
import {
  confirmBlock,
  confirmLabel,
  distFromEntry,
  fmtCountdown,
  fmtPrice,
  fmtSize,
  fmtUsd2,
  PREVIEW_AMBER_MS,
  previewRemainingMs,
  STALE_TEXT,
  stopResolution,
  type DeskVenue,
} from './order'

// PreviewCard — DESIGN-terminal §7.3/§7.4. The review step: resolved numbers
// (risk of book is the headline), how each was derived (notes), what the
// parser assumed, the governor's verdict verbatim, warnings, and CONFIRM.
// A 60 s countdown starts at receipt; at 0 (or when the page marks it stale:
// a 409 or an ADJUST edit) the body drops to 70%, an amber strip explains,
// and CONFIRM becomes RE-PREVIEW. CONFIRM only opens the Level 2 dialog; the
// page owns the actual POST.

const VERDICT: Record<OrderPreview['verdict']['decision'], { tone: Tone; word: string }> = {
  approve: { tone: 'green', word: 'PASS' },
  clip: { tone: 'amber', word: 'CLIPPED' },
  reject: { tone: 'red', word: 'REJECTED' },
}

function Fact({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="label text-xs">{label}</span>
      <span className="text-sm tabular text-text-primary break-words">{children}</span>
      {sub && <span className="text-[10px] text-text-muted break-words">{sub}</span>}
    </div>
  )
}

export function PreviewCard({
  preview,
  venue,
  venueError,
  receivedAt,
  stale,
  parsedFrom,
  busy = false,
  onConfirm,
  onRepreview,
  onExpire,
}: {
  preview: OrderPreview
  /** The Desk status venue (null while unknown). */
  venue: DeskVenue | null
  venueError?: string | null
  /** ms epoch the preview response landed. */
  receivedAt: number
  /** Set by the page: verbatim 409 message or the edit notice. */
  stale: string | null
  parsedFrom?: string
  /** A preview or confirm request is in flight. */
  busy?: boolean
  onConfirm: () => void
  onRepreview: () => void
  onExpire?: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const remaining = previewRemainingMs(preview.expiresAt, receivedAt, now)
  const expired = remaining <= 0
  const isStale = stale != null || expired

  // Countdown is content (it ticks under reduced motion too); not a live region.
  useEffect(() => {
    if (isStale) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isStale, receivedAt])

  const expiredFor = useRef<number | null>(null)
  useEffect(() => {
    if (expired && expiredFor.current !== receivedAt) {
      expiredFor.current = receivedAt
      onExpire?.()
    }
  }, [expired, receivedAt, onExpire])

  const { intent, resolved: r, verdict } = preview
  const sideLong = intent.side === 'long'
  const v = VERDICT[verdict.decision]
  const block = confirmBlock(preview, venue, venueError)
  const warnings = [...new Set([...preview.warnings, ...verdict.warnings.filter((w) => w !== verdict.clip)])]
  const otherNotes = (preview.notes ?? []).filter((n) => !n.startsWith('stop ='))

  return (
    <Panel>
      <PanelHeader title="PREVIEW">
        <VenueBadge venue={venue} />
        {isStale ? (
          <span className="text-[10px] tabular text-amber">STALE</span>
        ) : (
          <span className={`text-[10px] tabular ${remaining < PREVIEW_AMBER_MS ? 'text-amber' : 'text-text-secondary'}`} title="confirm is refused after 60 s">
            VALID {fmtCountdown(remaining)}
          </span>
        )}
      </PanelHeader>
      {isStale && (
        <div role="status" className="px-3 py-1.5 text-[11px] text-amber bg-amber-bg border-b border-border-subtle">
          {stale ?? STALE_TEXT}
        </div>
      )}
      <PanelBody className="p-3 flex flex-col gap-3">
        <div className={`flex flex-col gap-3 ${isStale ? 'opacity-70' : ''}`} aria-disabled={isStale || undefined} data-stale={isStale || undefined}>
          <div className="text-lg tabular">
            <span className={sideLong ? 'text-green' : 'text-red-text'}>{sideLong ? 'LONG' : 'SHORT'}</span> <span className="text-text-primary">{intent.asset}</span>{' '}
            <span className="text-text-secondary">{intent.leverage}×</span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xl tabular text-text-primary">{r.riskPct.toFixed(1)}%</span>
            <span className="label">RISK OF BOOK</span>
            <span className="text-sm tabular text-text-muted">· {fmtUsd2(r.riskUsd)}</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Fact label="SIZE">
              {fmtSize(r.size)} {intent.asset}
            </Fact>
            <Fact label="NOTIONAL">{fmtUsd2(r.notionalUsd)}</Fact>
            <Fact label="ENTRY">{intent.entry.type === 'limit' ? `LIMIT ${fmtPrice(intent.entry.px)}` : `MARKET ≈ ${fmtPrice(r.entryPx)}`}</Fact>
            <Fact label="STOP" sub={`${stopResolution(intent, preview.notes)} · ${distFromEntry(r.stopPx, r.entryPx)}`}>
              {fmtPrice(r.stopPx)}
            </Fact>
            <Fact label="LIQ" sub={r.liqPx != null ? `${distFromEntry(r.liqPx, r.entryPx)} from entry` : undefined}>
              {fmtPrice(r.liqPx)}
            </Fact>
            <Fact label="TARGET">{intent.target != null ? fmtPrice(intent.target) : '—'}</Fact>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label">GOVERNOR</span>
              <Badge tone={v.tone}>{v.word}</Badge>
              {verdict.clip && <span className="text-[11px] text-text-primary">{verdict.clip}</span>}
            </div>
            {verdict.reasons.length > 0 && (
              <ul aria-label="governor reasons" className="flex flex-col gap-0.5">
                {verdict.reasons.map((reason, i) => (
                  <li key={i} className="text-[11px] text-text-muted">
                    {reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {otherNotes.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <span className="label text-xs">HOW IT RESOLVED</span>
              <ul aria-label="resolution notes" className="flex flex-col gap-0.5">
                {otherNotes.map((n, i) => (
                  <li key={i} className="text-[10px] text-text-muted">
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.assumptions && preview.assumptions.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="label text-xs">ASSUMED BY THE PARSER</span>
              <ol className="flex flex-col gap-1.5">
                {preview.assumptions.map((a, i) => (
                  <ClaimLine key={i} claim={{ tag: 'hypothesis', text: a }} as="li" />
                ))}
              </ol>
            </div>
          )}
        </div>
        <LabWarnings warnings={warnings} />
        {parsedFrom && <p className="text-[10px] text-text-secondary break-words">PARSED FROM "{parsedFrom}"</p>}
        {isStale ? (
          <Button tier="neutral" className="h-[var(--control-lg)] w-full" onClick={onRepreview} disabled={busy}>
            <span className={busy ? 'pulse-label' : undefined}>{busy ? 'PREVIEWING…' : 'RE-PREVIEW'}</span>
          </Button>
        ) : (
          <div className="flex flex-col gap-1">
            <Button tier="neutral" className="h-[var(--control-lg)] w-full" onClick={onConfirm} disabled={block != null || busy} aria-describedby={block ? 'confirm-block' : undefined}>
              {confirmLabel(venue)}
            </Button>
            {block && (
              <span id="confirm-block" className="text-[10px] text-red-text">
                {block}
              </span>
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
