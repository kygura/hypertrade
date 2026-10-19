import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, DialogShell, EmptyBlock, ErrorBlock, MetricStat, OfflineBlock, Panel, SkeletonRows, StaleStrip } from '../../components'
import { VenueBadge } from '../../components/intel/VenueBadge'
import { fmtUsdCompact } from '../../components/branches/format'
import { fmtAge } from '../../components/strategy/format'
import { fmtPx, fmtUsd } from '../../lib/desk'
import type { OpportunityDetail as Detail, LedgerStats, OpportunityStatus } from '../../../shared/platform'
import { fmtSigned, fmtSignedPct, isLive, STATUS_WORD } from './logic'
import { EdgeCell, StatusPill } from './Feed'
import { KeyHint } from './Header'

// OpportunityDetail (sections 1–5) + ActionBar / TicketDialog / RejectDialog /
// SnoozeMenu — DESIGN-terminal C5. Presentational; Cockpit.tsx owns the POSTs.

type Venue = 'paper' | 'testnet' | null
/** Section 4 sub-rows: the same setup restricted to this idea's regime / tier (GET /ledger/stats?regime= / ?tier=). */
export type SubStats = { regime: LedgerStats | null; tier: LedgerStats | null }
const bp = (n: number) => fmtSigned(n, 'bp')

export const canApprove = (s: OpportunityStatus) => s === 'ready'
export const canReject = (s: OpportunityStatus) => s === 'ready' || s === 'approved'

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-3 py-3 border-t border-border-subtle" aria-labelledby={`detail-s${n}`}>
      <h3 id={`detail-s${n}`} className="label">
        {n} {title}
      </h3>
      {children}
    </section>
  )
}

export const OpportunityDetail = forwardRef<
  HTMLHeadingElement,
  {
    detail: Detail | null
    subStats: SubStats | null
    offline: string | null
    error: string | null
    notFound: boolean
    inFeed: boolean
    mark: number | null
    midAgeSec: number | null
    onRetry: () => void
    onBack: () => void
    onResearch: () => void
    /** Phone/md: the liquidation panel sits under the header (C2). */
    liqSlot: ReactNode
    actionBar: ReactNode
  }
>(function OpportunityDetail({ detail, subStats, offline, error, notFound, inFeed, mark, midAgeSec, onRetry, onBack, onResearch, liqSlot, actionBar }, headingRef) {
  const back = (
    <div className="lg:hidden px-3 pt-2">
      <Button tier="ghost" onClick={onBack} className="min-h-[var(--tap-min)]">
        ← FEED
      </Button>
    </div>
  )
  if (!detail) {
    let body
    if (notFound) body = <EmptyBlock label="opportunity not found" />
    else if (offline) body = <OfflineBlock message="platform API unreachable" onRetry={onRetry} />
    else if (error) body = <ErrorBlock message={error} onRetry={onRetry} />
    else body = <SkeletonRows rows={5} />
    return (
      <Panel>
        {back}
        {body}
      </Panel>
    )
  }
  const o = detail.opportunity
  const px = mark ?? o.entryPx
  return (
    <Panel className="min-w-0 flex flex-col">
      {back}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-[13px] text-text-primary font-display tracking-wider outline-none focus-visible:outline">
          {o.coin} · {o.direction.toUpperCase()} · {o.setupKind}
        </h2>
        <StatusPill status={o.status} />
        <span className="text-[11px] tabular text-text-secondary">score {o.score.toFixed(2)}</span>
        <span className="text-[10px] tabular text-text-secondary">{fmtAge(o.createdAt)}</span>
        {!inFeed && <Badge tone="gray">NOT IN FEED</Badge>}
      </div>
      {midAgeSec != null && midAgeSec > 30 && <StaleStrip>live price {Math.floor(midAgeSec)}s old — approve is blocked</StaleStrip>}
      {liqSlot && <div className="px-2 pb-2">{liqSlot}</div>}
      <div className="flex flex-col">
        <div className="order-last lg:order-none sticky bottom-0 lg:bottom-auto lg:top-[92px] z-10 bg-[var(--color-panel)] border-t lg:border-t-0 lg:border-b border-border-subtle pb-[env(safe-area-inset-bottom)]">
          {actionBar}
        </div>
        <Section n={1} title="WHY IT PASSED">
          {detail.signals.length === 0 ? (
            <p className="text-[11px] text-text-secondary">no signals recorded</p>
          ) : (
            <div className="table-scroll">
              <table className="dt w-full text-[11px] tabular">
                <thead>
                  <tr className="border-b border-border">
                    <th className="label text-left px-2 py-1">SIGNAL</th>
                    <th className="label text-right px-2 py-1">VALUE</th>
                    <th className="label text-right px-2 py-1">Z</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.signals.map((s) => (
                    <tr key={s.name} className="border-b border-border-subtle">
                      <td className="px-2 py-1">{s.name}</td>
                      <td className="px-2 py-1 text-right">{s.value == null ? '—' : Number(s.value.toPrecision(4)).toString()}</td>
                      <td className={`px-2 py-1 text-right ${s.z != null && Math.abs(s.z) >= 2 ? 'text-amber' : ''}`}>
                        {s.z == null ? '—' : `${s.z > 0 ? '+' : s.z < 0 ? '−' : ''}${Math.abs(s.z).toFixed(1)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section n={2} title="COST TO TRADE">
          {o.costs && o.grossEdgeBps != null ? (
            <>
              <p className="text-[11px] tabular text-text-muted">
                gross {bp(o.grossEdgeBps)} − fees 2×{o.costs.feeBps}bp − slippage {o.costs.slippageBps.toFixed(0)}bp − funding {o.costs.fundingBps.toFixed(0)}bp = net{' '}
                {o.netEdgeBps == null ? '—' : bp(o.netEdgeBps)}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-5 border border-border-subtle">
                <MetricStat label="GROSS" value={bp(o.grossEdgeBps)} />
                <MetricStat label="FEES" value={`2×${o.costs.feeBps}bp`} />
                <MetricStat label="SLIPPAGE" value={`${o.costs.slippageBps.toFixed(0)}bp`} />
                <MetricStat label="FUNDING" value={bp(o.costs.fundingBps)} />
                <MetricStat label="NET" value={o.netEdgeBps == null ? '—' : bp(o.netEdgeBps)} />
              </div>
              <p className="text-[11px] tabular text-text-secondary">{fmtUsdCompact(o.costs.absorbableUsd)} absorbable (10% of depth ±0.5%)</p>
            </>
          ) : (
            <p className="text-[11px] text-text-secondary">no cost breakdown yet</p>
          )}
          <EdgeCell row={o} />
        </Section>
        <Section n={3} title="INVALIDATION & BEAR CASE">
          {o.invalidationPx != null && (
            <p className="text-[11px] tabular">
              {fmtPx(o.invalidationPx)}
              {px != null && <span className="text-text-secondary"> · {fmtSignedPct(o.invalidationPx / px - 1, 1)} from mark</span>}
            </p>
          )}
          <p className="text-[11px] text-text-muted">{o.invalidation}</p>
          {o.status === 'investigating' ? (
            <span className="label pulse-label">RESEARCHING…</span>
          ) : detail.bearCase ? (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-text-secondary">model words</span>
              <p className="text-[12px] text-text-primary whitespace-pre-line">{detail.bearCase}</p>
            </div>
          ) : (
            <EmptyBlock label="no research yet" action={isLive(o.status) ? { label: 'RESEARCH', onClick: onResearch } : undefined} />
          )}
        </Section>
        <Section n={4} title="HAVE SIMILAR SETUPS PAID">
          <SimilarSetups stats={detail.stats} evidence={detail.evidence} />
          {subStats?.regime && <SimilarSetups stats={subStats.regime} label={`REGIME ${o.regime}`} />}
          {subStats?.tier && <SimilarSetups stats={subStats.tier} label={`TIER T${o.liquidityTier}`} />}
        </Section>
        <Section n={5} title="PORTFOLIO RISK">
          <PortfolioRisk risk={detail.risk} />
        </Section>
      </div>
    </Panel>
  )
})

function SimilarSetups({ stats, label, evidence }: { stats: Detail['stats']; label?: string; evidence?: string }) {
  const head = label && <span className="label">{label}</span>
  if (!stats || stats.ci95 == null)
    return (
      <p className="flex flex-wrap gap-2 text-[11px] tabular text-text-secondary">
        {head}
        <span>{evidence ?? `n ${stats?.n ?? 0} · ${stats?.clusters ?? 0} clusters`}</span>
      </p>
    )
  const [lo, hi] = stats.ci95
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] tabular">
      {head}
      <span>
        n {stats.n} · hit {stats.hitRate == null ? '—' : `${Math.round(stats.hitRate * 100)}%`} · mean net {stats.meanNet == null ? '—' : fmtSignedPct(stats.meanNet)} · 95% CI {fmtSignedPct(lo)} to {fmtSignedPct(hi)}
      </span>
      <span className="text-text-secondary">({stats.horizon})</span>
      {lo < 0 && hi > 0 && <Badge tone="gray">NOT DISTINGUISHABLE FROM ZERO</Badge>}
    </div>
  )
}

type Verdict = NonNullable<Detail['risk']>['before']

function PortfolioRisk({ risk }: { risk: Detail['risk'] }) {
  if (!risk) return <p className="text-[11px] text-text-secondary">no governor preview</p>
  const col = (label: string, v: Verdict) => {
    const s = v.sizing
    return (
      <div className="flex flex-col gap-1 text-[11px] tabular">
        <span className="label">{label}</span>
        <span>{v.approved ? 'PASSES' : 'BLOCKED'}</span>
        {s?.notionalUsd != null && <span className="text-text-secondary">notional {fmtUsd(s.notionalUsd)}</span>}
        {s?.grossLeverageAfter != null && <span className="text-text-secondary">gross leverage {s.grossLeverageAfter.toFixed(2)}×</span>}
        {s?.riskUsd != null && <span className="text-text-secondary">risk {fmtUsd(s.riskUsd)}</span>}
        {v.warnings.map((w) => (
          <span key={w} className="text-amber">
            {w}
          </span>
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {!risk.after.approved && (
        <div className="flex flex-col gap-1">
          <Badge tone="red" className="self-start">
            GOVERNOR BLOCKS
          </Badge>
          {risk.after.reasons.map((r) => (
            <p key={r} className="text-[11px] text-red-text">
              {r}
            </p>
          ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {col('BEFORE', risk.before)}
        {col('AFTER', risk.after)}
      </div>
      <p className="text-[10px] text-text-secondary">margin use is not in the governor preview this phase</p>
    </div>
  )
}

// ─── Actions ───

export function ActionBar({
  status,
  blockedReason,
  venue,
  busy,
  error,
  hint,
  snoozeOpen,
  onApprove,
  onReject,
  onSnoozeMenu,
  onSnooze,
  onCloseSnooze,
  onResearch,
}: {
  status: OpportunityStatus
  blockedReason: string | null
  venue: Venue
  busy: boolean
  error: string | null
  hint: string | null
  snoozeOpen: boolean
  onApprove: () => void
  onReject: () => void
  onSnoozeMenu: () => void
  onSnooze: (minutes: number) => void
  onCloseSnooze: () => void
  onResearch: () => void
}) {
  const investigating = status === 'investigating'
  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          tier="neutral"
          onClick={onApprove}
          disabled={busy || !canApprove(status) || blockedReason != null}
          title={blockedReason ?? (canApprove(status) ? undefined : `approve needs READY — status is ${STATUS_WORD[status]}`)}
          className="min-h-[var(--tap-min)]"
        >
          APPROVE <KeyHint k="a" />
        </Button>
        <Button tier="ghost" onClick={onReject} disabled={busy || !canReject(status)} className="min-h-[var(--tap-min)]">
          REJECT <KeyHint k="r" />
        </Button>
        <div className="relative">
          <Button tier="ghost" onClick={onSnoozeMenu} disabled={busy || !isLive(status)} aria-haspopup="menu" aria-expanded={snoozeOpen} className="min-h-[var(--tap-min)]">
            SNOOZE ▾ <KeyHint k="s" />
          </Button>
          {snoozeOpen && <SnoozeMenu onSnooze={onSnooze} onClose={onCloseSnooze} />}
        </div>
        <Button
          tier="ghost"
          onClick={onResearch}
          disabled={busy || investigating || !isLive(status)}
          title={investigating ? 'research is already running' : undefined}
          className="min-h-[var(--tap-min)]"
        >
          RESEARCH <KeyHint k="d" />
        </Button>
        <span className="ml-auto">
          <VenueBadge venue={venue} />
        </span>
      </div>
      {hint && (
        <p className="text-[10px] text-amber" role="status">
          {hint}
        </p>
      )}
      {error && <ErrorBlock message={error} />}
    </div>
  )
}

const SNOOZES = [
  { minutes: 15, label: '15M', key: '1' },
  { minutes: 60, label: '1H', key: '2' },
  { minutes: 240, label: '4H', key: '3' },
] as const

export function SnoozeMenu({ onSnooze, onClose }: { onSnooze: (minutes: number) => void; onClose: () => void }) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    first.current?.focus()
    return () => opener?.focus?.()
  }, [])
  return (
    <div role="menu" aria-label="snooze for" className="panel absolute z-20 left-0 top-full mt-1 flex flex-col min-w-[120px]" style={{ boxShadow: 'var(--shadow-overlay)' }} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && onClose()}>
      {SNOOZES.map((s, i) => (
        <button
          key={s.minutes}
          ref={i === 0 ? first : undefined}
          type="button"
          role="menuitem"
          className="flex justify-between gap-3 px-3 py-1.5 min-h-[var(--tap-min)] text-[11px] text-left hover:bg-hover focus-visible:bg-hover"
          onClick={() => onSnooze(s.minutes)}
        >
          <span>{s.label}</span>
          <KeyHint k={s.key} />
        </button>
      ))}
    </div>
  )
}

export function TicketDialog({
  detail,
  venue,
  busy,
  error,
  stale,
  onConfirm,
  onCancel,
}: {
  detail: Detail
  venue: Venue
  busy: boolean
  error: string | null
  /** 409 stale_feed: the server string, verbatim. */
  stale: string | null
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = detail.ticket
  const o = detail.opportunity
  const rows: [string, string][] = [
    ['SIDE', t.side.toUpperCase()],
    ['SIZE', t.sizeUsd == null ? 'size unavailable' : fmtUsd(t.sizeUsd)],
    ['ENTRY REF', fmtPx(t.entryPx)],
    ['STOP', fmtPx(t.stopPx)],
    ['TARGET', fmtPx(t.targetPx)],
    ['NET EDGE', o.netEdgeBps == null ? '—' : bp(o.netEdgeBps)],
  ]
  return (
    <DialogShell
      className="md:max-w-[400px]"
      title={
        <>
          APPROVE — {venue === 'testnet' ? 'TESTNET' : venue === 'paper' ? 'PAPER' : '…'} <VenueBadge venue={venue} />
        </>
      }
      onClose={onCancel}
    >
      <p className="text-[12px] text-text-muted">
        {o.coin} · {o.direction.toUpperCase()} · {o.setupKind}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px] tabular">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="label">{k}</dt>
            <dd className="text-right text-text-primary">{v}</dd>
          </div>
        ))}
      </dl>
      {stale && (
        <div className="flex items-center justify-between gap-2 bg-amber-bg">
          <StaleStrip>{stale}</StaleStrip>
          <Button tier="ghost" onClick={onConfirm} disabled={busy} className="flex-shrink-0">
            RETRY
          </Button>
        </div>
      )}
      {error && !stale && <ErrorBlock message={error} />}
      <div className="flex justify-end gap-2">
        <Button tier="ghost" onClick={onCancel} disabled={busy} data-autofocus>
          CANCEL
        </Button>
        <Button tier="neutral" onClick={onConfirm} disabled={busy || stale != null || t.sizeUsd == null}>
          <span className={busy ? 'pulse-label' : undefined}>{busy ? 'CONFIRM…' : 'CONFIRM'}</span>
        </Button>
      </div>
    </DialogShell>
  )
}

export function RejectDialog({ busy, error, onConfirm, onCancel }: { busy: boolean; error: string | null; onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('')
  return (
    <DialogShell title="REJECT" onClose={onCancel} className="md:max-w-[400px]">
      <label className="flex flex-col gap-1">
        <span className="label">REASON</span>
        <textarea data-autofocus required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} className="w-full" />
      </label>
      {error && <ErrorBlock message={error} />}
      <div className="flex justify-end gap-2">
        <Button tier="ghost" onClick={onCancel} disabled={busy}>
          CANCEL
        </Button>
        <Button tier="danger" onClick={() => onConfirm(reason.trim())} disabled={busy || reason.trim() === ''}>
          <span className={busy ? 'pulse-label' : undefined}>{busy ? 'CONFIRM…' : 'CONFIRM'}</span>
        </Button>
      </div>
    </DialogShell>
  )
}
