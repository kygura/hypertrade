import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { Badge, DataTable, EmptyBlock, ErrorBlock, SkeletonRows, type Column } from '../components'
import { engine, useEngine } from '../lib/engine'
import type { DecisionRecord } from '../../shared/strategy-protocol'
import { EngineTabs } from '../components/strategy/EngineTabs'
import { EngineOffline, OfflineStrip } from '../components/strategy/EngineOffline'
import { VerdictBadge } from '../components/strategy/VerdictBadge'
import { latestVerdict } from '../components/strategy/IntentRow'
import { ACTION_LABEL, actionClass, fmtAge, fmtTsSec } from '../components/strategy/format'

// /decisions — newest first, filter by strategy (?strategy=id, so the
// filter is linkable). Columns (§4.4): P1 TS, STRATEGY · P2 ACTION · P3
// VENUE, VERDICT · P4 MODEL. Dry runs carry an info badge on the TS cell so
// the flag survives column triage on a phone. Polls every 5s (no WS in this
// scaffold).

function summarizeAction(d: DecisionRecord): { text: string; className: string } {
  if (d.error) return { text: 'ERROR', className: 'text-red-text' }
  const first = d.intents[0]
  if (!first) return { text: 'HOLD', className: 'text-text-muted' }
  const more = d.intents.length > 1 ? ` +${d.intents.length - 1}` : ''
  return { text: `${ACTION_LABEL[first.action]} ${first.market}${more}`, className: actionClass(first.action) }
}

export function Decisions() {
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const strategy = search.get('strategy') ?? ''

  const decisions = useEngine(() => engine.listDecisions({ limit: 50, strategy: strategy || undefined }), [strategy])
  const strategies = useEngine(() => engine.listStrategies(), [], { intervalMs: null })

  const rows = useMemo(() => [...(decisions.data ?? [])].sort((a, b) => b.ts.localeCompare(a.ts)), [decisions.data])

  const strategyIds = useMemo(() => {
    const ids = new Set<string>((strategies.data ?? []).map((s) => s.config.id))
    for (const d of decisions.data ?? []) ids.add(d.strategy_id)
    if (strategy) ids.add(strategy)
    return [...ids].sort()
  }, [strategies.data, decisions.data, strategy])

  const columns: Column<DecisionRecord>[] = [
    {
      key: 'ts',
      label: 'TIME',
      priority: 1,
      render: (d) => (
        <div className="flex flex-col gap-0.5 py-1">
          <span className="flex items-center gap-1.5 tabular text-text-primary">
            {fmtAge(d.ts)}
            {d.dry_run && <Badge tone="info">DRY</Badge>}
          </span>
          <span className="text-[10px] text-text-secondary tabular">{fmtTsSec(d.ts)}</span>
        </div>
      ),
    },
    {
      key: 'strategy',
      label: 'STRATEGY',
      priority: 1,
      render: (d) => <span className="text-text-muted">{d.strategy_id}</span>,
    },
    {
      key: 'action',
      label: 'ACTION',
      priority: 2,
      render: (d) => {
        const a = summarizeAction(d)
        return <span className={`uppercase ${a.className}`}>{a.text}</span>
      },
    },
    {
      key: 'venue',
      label: 'VENUE',
      priority: 3,
      render: (d) => <span className="text-text-secondary">{d.venue}</span>,
    },
    {
      key: 'verdict',
      label: 'VERDICT',
      priority: 3,
      render: (d) => {
        const first = d.intents[0]
        const v = first ? latestVerdict(d.verdicts, first.id) : null
        if (d.dry_run) return <span className="text-[10px] uppercase text-text-secondary">—</span>
        return v ? <VerdictBadge status={v.status} /> : <span className="text-[10px] uppercase text-text-secondary">—</span>
      },
    },
    {
      key: 'model',
      label: 'MODEL',
      priority: 4,
      align: 'right',
      render: (d) => (
        <span className="tabular text-text-secondary">
          {d.model || '—'}
          {d.latency_ms != null && ` · ${d.latency_ms}ms`}
        </span>
      ),
    },
  ]

  const { data, loading, error, offline, fetchedAt, refetch } = decisions

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <EngineTabs />
      <div className="panel">
        {offline && data && <OfflineStrip reason={offline} fetchedAt={fetchedAt} />}
        <div className="panel-header flex-wrap gap-2">
          <span className="panel-title">DECISIONS</span>
          <label className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-text-secondary">STRATEGY</span>
            <select
              value={strategy}
              onChange={(e) => {
                const next = new URLSearchParams(search)
                if (e.target.value) next.set('strategy', e.target.value)
                else next.delete('strategy')
                setSearch(next, { replace: true })
              }}
              className="min-w-[12ch]"
              style={{ minHeight: 'var(--control-sm)', padding: '2px 6px' }}
            >
              <option value="">ALL</option>
              {strategyIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="panel-body">
          {loading && !data && (
            <table className="w-full">
              <tbody>
                <SkeletonRows rows={4} colSpan={columns.length} />
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
                rows={rows}
                rowKey={(d) => d.id}
                onRowClick={(d) => navigate(`/decisions/${d.id}`)}
                emptyLabel={<EmptyBlock label={strategy ? `no decisions for ${strategy}` : 'no decisions yet'} />}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
