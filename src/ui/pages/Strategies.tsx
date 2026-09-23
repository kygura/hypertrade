import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { DataTable, EmptyBlock, ErrorBlock, SkeletonRows, type Column } from '../components'
import { engine, errorMessage, useEngine } from '../lib/engine'
import type { DecisionRecord, StrategyStatus } from '../../shared/strategy-protocol'
import { EngineTabs } from '../components/strategy/EngineTabs'
import { EngineOffline, OfflineStrip } from '../components/strategy/EngineOffline'
import { ACTION_LABEL, actionClass, fmtAge, fmtTs } from '../components/strategy/format'

// /strategies — manifests × configs. Columns (DESIGN.md §4.4 drop order):
// P1 ID, ENABLED · P2 VENUE · P3 CADENCE, LAST RUN · P4 LAST ACTION.
// The enabled toggle PUTs the config in place (Level 1 action; row click is
// the drill-in, so the toggle stops propagation). LAST ACTION is derived
// from the newest decision per strategy — StrategyStatus carries only
// last_decision_id, so the page also polls /decisions.

function lastActionOf(d: DecisionRecord | undefined): { text: string; className: string } {
  if (!d) return { text: '—', className: 'text-text-secondary' }
  if (d.error) return { text: 'ERROR', className: 'text-red-text' }
  const first = d.intents[0]
  if (!first) return { text: 'HOLD', className: 'text-text-muted' }
  const more = d.intents.length > 1 ? ` +${d.intents.length - 1}` : ''
  return { text: `${ACTION_LABEL[first.action]} ${first.market}${more}${d.dry_run ? ' (DRY)' : ''}`, className: actionClass(first.action) }
}

export function Strategies() {
  const navigate = useNavigate()
  const strategies = useEngine(() => engine.listStrategies(), [])
  const decisions = useEngine(() => engine.listDecisions({ limit: 50 }), [])
  const [toggling, setToggling] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const latestByStrategy = useMemo(() => {
    const m = new Map<string, DecisionRecord>()
    for (const d of decisions.data ?? []) {
      const cur = m.get(d.strategy_id)
      if (!cur || d.ts > cur.ts) m.set(d.strategy_id, d)
    }
    return m
  }, [decisions.data])

  async function toggle(s: StrategyStatus) {
    setToggling(s.config.id)
    setToggleError(null)
    try {
      const updated = await engine.putConfig(s.config.id, { ...s.config, enabled: !s.config.enabled })
      strategies.setData((strategies.data ?? []).map((row) => (row.config.id === updated.config.id ? updated : row)))
    } catch (err) {
      setToggleError(errorMessage(err, 'toggle failed'))
    } finally {
      setToggling(null)
    }
  }

  const columns: Column<StrategyStatus>[] = [
    {
      key: 'id',
      label: 'ID',
      priority: 1,
      render: (s) => (
        <div className="flex flex-col gap-0.5 py-1 min-w-0">
          <span className="text-text-primary">{s.config.id}</span>
          <span className="text-[10px] text-text-secondary truncate">
            {s.manifest.name} · v{s.manifest.version}
          </span>
          {s.last_error && <span className="text-[10px] text-red-text truncate">{s.last_error}</span>}
        </div>
      ),
    },
    {
      key: 'enabled',
      label: 'ENABLED',
      priority: 1,
      render: (s) => {
        const busy = toggling === s.config.id
        const on = s.config.enabled
        return (
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={`${on ? 'disable' : 'enable'} ${s.config.id}`}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              void toggle(s)
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className={`h-[var(--control-sm)] min-w-[5ch] px-2 text-[10px] font-mono uppercase tracking-wider border border-border ${
              on ? 'text-green bg-green-bg' : 'text-text-secondary'
            } ${busy ? 'pulse-label' : ''}`}
          >
            {on ? 'ON' : 'OFF'}
          </button>
        )
      },
    },
    {
      key: 'venue',
      label: 'VENUE',
      priority: 2,
      render: (s) => <span className="text-text-muted">{s.config.venue}</span>,
    },
    {
      key: 'cadence',
      label: 'CADENCE',
      priority: 3,
      align: 'right',
      render: (s) => <span className="tabular text-text-muted">{s.manifest.cadence || '—'}</span>,
    },
    {
      key: 'last_run',
      label: 'LAST RUN',
      priority: 3,
      align: 'right',
      render: (s) => (
        <span className="tabular text-text-secondary" title={fmtTs(s.last_run_at)}>
          {fmtAge(s.last_run_at)}
        </span>
      ),
    },
    {
      key: 'last_action',
      label: 'LAST ACTION',
      priority: 4,
      align: 'right',
      render: (s) => {
        const a = lastActionOf(latestByStrategy.get(s.config.id))
        return <span className={`uppercase ${a.className}`}>{a.text}</span>
      },
    },
  ]

  const { data, loading, error, offline, fetchedAt, refetch } = strategies

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <EngineTabs />
      <div className="panel">
        {offline && data && <OfflineStrip reason={offline} fetchedAt={fetchedAt} />}
        <div className="panel-header">
          <span className="panel-title">STRATEGIES</span>
          {data && <span className="text-[10px] text-text-secondary tabular">{data.length} CONFIGURED</span>}
        </div>
        <div className="panel-body">
          {toggleError && <ErrorBlock message={toggleError} />}
          {loading && !data && (
            <table className="w-full">
              <tbody>
                <SkeletonRows rows={3} colSpan={columns.length} />
              </tbody>
            </table>
          )}
          {!loading && offline && !data && <EngineOffline reason={offline} onRetry={refetch} />}
          {!loading && !offline && error && !data && <ErrorBlock message={error} onRetry={refetch} />}
          {data && (
            <>
              {error && <ErrorBlock message={error} onRetry={refetch} />}
              <DataTable
                columns={columns}
                rows={data}
                rowKey={(s) => s.config.id}
                onRowClick={(s) => navigate(`/strategies/${s.config.id}`)}
                emptyLabel={<EmptyBlock label="no strategies registered on the core" />}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
