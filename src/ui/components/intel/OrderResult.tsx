import { Link } from 'react-router'
import type { OrderConfirmResponse } from '../../../shared/intel'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { ClaimAge } from './ClaimAge'
import { fmtPrice, fmtSize, fmtUsd2, type DeskVenue } from './order'

// OrderResult — DESIGN-terminal §7.3. After a confirmed order: `PLACED ·
// PAPER` + the fill summary + age, `OPEN DESK →`, `NEW ORDER` (keeps the
// composer text). Gap: §7.3 only draws the placed case; the Desk can also
// record the confirm as `blocked` (the governor re-checked on fresh marks) or
// `failed` (the venue refused), so those print a red Badge with the verbatim
// reasons / error instead (DESIGN §6: server strings verbatim).

interface Fill {
  side: string
  size: number
  px: number
  fee: number
}

function readExecution(x: unknown): { ok: boolean; fills: Fill[]; error?: string } | null {
  if (!x || typeof x !== 'object') return null
  const e = x as { ok?: unknown; fills?: unknown; error?: unknown }
  const fills = Array.isArray(e.fills)
    ? e.fills.filter((f): f is Fill => !!f && typeof f === 'object' && typeof (f as Fill).size === 'number' && typeof (f as Fill).px === 'number')
    : []
  return { ok: e.ok === true, fills, ...(typeof e.error === 'string' ? { error: e.error } : {}) }
}

export function OrderResult({
  result,
  venue,
  asset,
  placedAt,
  onNew,
}: {
  result: OrderConfirmResponse
  venue: DeskVenue | null
  asset: string
  placedAt: string
  onNew: () => void
}) {
  const v = venue === 'testnet' ? 'TESTNET' : 'PAPER'
  const exec = readExecution(result.execution)
  const placed = result.status === 'executed' && exec?.ok !== false
  const word = placed ? 'PLACED' : result.status.toUpperCase()

  return (
    <Panel>
      <PanelHeader title="ORDER">
        <ClaimAge ts={placedAt} />
      </PanelHeader>
      <PanelBody className="p-3 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={placed ? 'green' : 'red'}>
            {word} · {v}
          </Badge>
          <span className="text-[10px] text-text-secondary tabular">proposal {result.proposalId}</span>
        </div>
        {exec && exec.fills.length > 0 && (
          <ul aria-label="fills" className="flex flex-col gap-0.5 text-sm tabular text-text-primary">
            {exec.fills.map((f, i) => (
              <li key={i}>
                {String(f.side).toUpperCase()} {fmtSize(f.size)} {asset} @ {fmtPrice(f.px)}
                {Number.isFinite(f.fee) && <span className="text-text-secondary"> · fee {fmtUsd2(f.fee)}</span>}
              </li>
            ))}
          </ul>
        )}
        {!placed && (
          <ul aria-label="reasons" className="flex flex-col gap-0.5">
            {[...result.verdict.reasons, ...(exec?.error ? [exec.error] : [])].map((r, i) => (
              <li key={i} className="text-[11px] text-red-text">
                {r}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Link to="/desk" className="btn inline-flex items-center h-[var(--control-md)] px-2.5 text-[10px] border border-border text-text-secondary hover:text-text-primary hover:bg-hover rounded-control font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)]">
            OPEN DESK →
          </Link>
          <Button tier="ghost" onClick={onNew}>
            NEW ORDER
          </Button>
        </div>
      </PanelBody>
    </Panel>
  )
}
