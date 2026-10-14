import { useState } from 'react'
import { useNavigate } from 'react-router'
import type { FlowFlag } from '../../../shared/intel'
import { Button } from '../Button'
import { ClaimAge, claimAgeText } from './ClaimAge'
import { chipText, degradedChips, firingChips, numbersLine } from './flow'

// DetectorChips — DESIGN-terminal §15.3. `DETECTORS` then one gray chip per
// (name, asset), ordered by the row's materiality then newest. Max 8, then
// `+N MORE`. Hover = numbers line + age; tap/Enter expands one line under
// the row (Esc collapses). Degraded detectors get one dashed summary chip
// each: "cannot fire", never "did not fire".

const MAX_VISIBLE = 8
const CHIP = 'badge inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-badge font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)]'

export function DetectorChips({ flags, materiality }: { flags: FlowFlag[]; materiality: Map<string, number> }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const firing = firingChips(flags, materiality)
  const degraded = degradedChips(flags)
  const shown = all ? firing : firing.slice(0, MAX_VISIBLE)
  const openFlag = firing.find((f) => f.id === open)
  const openDegraded = degraded.find((d) => d.key === open)
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id))

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2" onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="label">DETECTORS</span>
        {firing.length === 0 && <span className="text-[10px] text-text-secondary">no detectors firing</span>}
        {shown.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-expanded={open === f.id}
            title={`${numbersLine(f)} · ${claimAgeText(f.ts)}`}
            onClick={() => toggle(f.id)}
            className={`${CHIP} border border-transparent bg-elevated text-text-secondary hover:text-text-primary`}
          >
            {chipText(f)}
          </button>
        ))}
        {firing.length > MAX_VISIBLE && (
          <Button tier="ghost" onClick={() => setAll((a) => !a)}>
            {all ? 'LESS' : `+${firing.length - MAX_VISIBLE} MORE`}
          </Button>
        )}
        {degraded.map((d) => (
          <button
            key={d.key}
            type="button"
            aria-expanded={open === d.key}
            title={d.reason}
            onClick={() => toggle(d.key)}
            className={`${CHIP} border border-dashed border-border text-text-secondary`}
          >
            {d.text}
          </button>
        ))}
      </div>
      {openFlag && (
        <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-text-primary tabular">
          <span>{numbersLine(openFlag)}</span>
          <ClaimAge ts={openFlag.ts} />
          <Button tier="ghost" onClick={() => navigate(`/asset/${encodeURIComponent(openFlag.asset)}`)}>
            OPEN {openFlag.asset} →
          </Button>
        </p>
      )}
      {openDegraded && (
        <p className="text-[11px] text-text-secondary">
          {openDegraded.reason} · see docs/research/flow-sources.md
        </p>
      )}
    </div>
  )
}
