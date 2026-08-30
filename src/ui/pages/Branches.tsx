import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Button, ConfirmDialog, DataTable, EmptyBlock, ErrorBlock, SkeletonRows, type Column } from '../components'
import { api, ApiError, useApi } from '../lib/api'
import type { Branch } from '../components/branches/types'
import { allocationSummary, defaultBranchConfig, fmtPct, maxDdClass, rebalanceLabel, signClass } from '../components/branches/format'

// /branches — DESIGN.md §10.3. List + create; delete is a per-row Level 2
// confirm. RETURN%/MAX DD/VS BTC come from GET /api/branches's left-joined
// cached result; branches never simulated render "—".

export function Branches() {
  const { data, loading, error, refetch } = useApi<Branch[]>('/branches')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Branch | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const navigate = useNavigate()

  async function createBranch() {
    setCreating(true)
    try {
      const branch = await api.post<Branch>('/branches', { name: 'UNTITLED', config: defaultBranchConfig() })
      navigate(`/branches/${branch.id}`)
    } catch {
      setCreating(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleteError(null)
    try {
      await api.del(`/branches/${deleteTarget.id}`)
      setDeleteTarget(null)
      refetch()
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'delete failed')
    }
  }

  const columns: Column<Branch>[] = [
    {
      key: 'name',
      label: 'NAME',
      priority: 1,
      render: (b) => (
        <div className="flex flex-col gap-0.5 py-1">
          <span className="text-text-primary">{b.name}</span>
          <span className="text-[10px] text-text-secondary">
            {allocationSummary(b.config.allocations)} · {rebalanceLabel(b.config.rebalance)}
          </span>
        </div>
      ),
    },
    {
      key: 'return',
      label: 'RETURN%',
      priority: 1,
      align: 'right',
      render: (b) =>
        b.result ? (
          <span className={signClass((b.result.stats.finalValue / b.config.initialCapitalUsd - 1) * 100)}>
            {fmtPct((b.result.stats.finalValue / b.config.initialCapitalUsd - 1) * 100)}
          </span>
        ) : (
          <span className="text-text-secondary">—</span>
        ),
    },
    {
      key: 'maxdd',
      label: 'MAX DD',
      priority: 2,
      align: 'right',
      render: (b) =>
        b.result ? (
          <span className={maxDdClass(b.result.stats.maxDrawdownPct)}>
            {fmtPct(-Math.abs(b.result.stats.maxDrawdownPct))}
          </span>
        ) : (
          <span className="text-text-secondary">—</span>
        ),
    },
    {
      key: 'vsbtc',
      label: 'VS BTC',
      priority: 3,
      align: 'right',
      render: (b) =>
        b.result ? (
          <span className={signClass(b.result.stats.vsBtcPct)}>{fmtPct(b.result.stats.vsBtcPct)}</span>
        ) : (
          <span className="text-text-secondary">—</span>
        ),
    },
    {
      key: 'updated',
      label: 'UPDATED',
      priority: 3,
      align: 'right',
      render: (b) => <span className="tabular text-text-secondary">{new Date(b.updatedAt).toISOString().slice(0, 10)}</span>,
    },
    {
      key: 'actions',
      label: '',
      priority: 1,
      align: 'right',
      render: (b) => (
        <Button
          tier="danger"
          className="!px-2"
          onClick={(e) => {
            e.stopPropagation()
            setDeleteTarget(b)
          }}
        >
          ✕
        </Button>
      ),
    },
  ]

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">BRANCHES</span>
          <Button tier="neutral" onClick={createBranch} disabled={creating}>
            <span className={creating ? 'pulse-label' : undefined}>{creating ? 'CREATING…' : 'NEW BRANCH'}</span>
          </Button>
        </div>
        <div className="panel-body">
          {loading && (
            <table className="w-full">
              <tbody>
                <SkeletonRows rows={4} colSpan={columns.length} />
              </tbody>
            </table>
          )}
          {!loading && error && <ErrorBlock message={error} onRetry={refetch} />}
          {!loading && !error && (
            <DataTable
              columns={columns}
              rows={data ?? []}
              rowKey={(b) => b.id}
              onRowClick={(b) => navigate(`/branches/${b.id}`)}
              emptyLabel={<EmptyBlock label="no branches yet" action={{ label: 'NEW BRANCH', onClick: createBranch }} />}
            />
          )}
        </div>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="DELETE BRANCH"
          body={`Delete "${deleteTarget.name}"? This cannot be undone.`}
          confirmLabel="DELETE"
          onConfirm={confirmDelete}
          onCancel={() => {
            setDeleteTarget(null)
            setDeleteError(null)
          }}
          error={deleteError}
        />
      )}
    </div>
  )
}
