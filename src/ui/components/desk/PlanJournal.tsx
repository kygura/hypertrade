import { Badge, type Tone } from '../Badge'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { AsyncBody } from '../state'
import { fmtPx } from '../../lib/format'
import type { DeskPlanRecord } from '../../lib/deskPlan'

// PlanJournal — the Desk's "PLANS" panel: recent written plans, placed or not
// (GET /desk/plans), each with what became of it and, when blocked, the first
// blocker. Compact; the record is history, not a prompt to act.

/** The badge for one journal entry. */
export function planStatus(p: Pick<DeskPlanRecord, 'placed' | 'placement' | 'blockers'>): { label: string; tone: Tone } {
  if (p.placement?.dryRun) return { label: 'DRY RUN', tone: 'amber' }
  if (p.placed) return { label: 'PLACED', tone: 'green' }
  if (p.placement) return { label: p.placement.status.toUpperCase(), tone: p.placement.status === 'failed' || p.placement.status === 'blocked' ? 'red' : 'gray' }
  if (p.blockers.length) return { label: 'BLOCKED', tone: 'gray' }
  return { label: 'SAVED', tone: 'gray' }
}

export function PlanJournal({ plans, loading, error, offline, onRetry }: { plans: DeskPlanRecord[] | undefined; loading: boolean; error: string | null; offline: boolean; onRetry: () => void }) {
  return (
    <Panel>
      <PanelHeader title="PLANS" />
      <PanelBody className="flex flex-col max-h-[360px] overflow-y-auto">
        <AsyncBody loading={loading} data={plans} error={error} offline={offline} onRetry={onRetry} rows={2} empty={{ label: 'No plans journaled yet.' }}>
          {(list) =>
            list.map((p) => {
              const s = planStatus(p)
              const i = p.input
              const n = i.rungs.length
              return (
                <div key={p.id} className="border-b border-border-subtle px-3 py-2 flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge tone={s.tone}>{s.label}</Badge>
                    <span className="text-sm text-text-primary truncate">
                      {i.side.toUpperCase()} {i.coin}
                    </span>
                    <span className="text-xs text-text-secondary tabular truncate">
                      {n} {n === 1 ? 'level' : 'levels'} · stop {fmtPx(i.stopPx)} · target {fmtPx(i.targetPx)}
                      {p.source === 'copilot' ? ' · copilot' : ''}
                    </span>
                    <span className="text-xs text-text-secondary ml-auto shrink-0 tabular">
                      {new Date(p.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {p.blockers.length > 0 && (
                    <span className="text-xs text-text-secondary truncate" title={p.blockers.join('\n')}>
                      ✕ {p.blockers[0]}
                      {p.blockers.length > 1 ? ` (+${p.blockers.length - 1} more)` : ''}
                    </span>
                  )}
                  {i.note && <span className="text-xs text-text-muted truncate">{i.note}</span>}
                </div>
              )
            })
          }
        </AsyncBody>
      </PanelBody>
    </Panel>
  )
}
