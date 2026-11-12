import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { AsyncBody, Button, DataTable, EmptyBlock, HowToRead, SkeletonRows, type Column, type Term } from '../components'
import { api, useApi } from '../lib/api'
import type { Branch } from '../components/branches/types'
import { allocationSummary, defaultBranchConfig, maxDdClass, rebalanceLabel, signClass } from '../components/branches/format'
import { fmtPct } from '../../shared/format'

// /branches — docs/design/README.md §10.3. List + create; delete lives only in the
// editor (/branches/:id), not here (§4.4 column set has no delete column).
// RETURN%/MAX DD/VS BTC come from GET /api/branches's left-joined cached
// result; branches never simulated render "—".

/** The list's columns; each number is the branch's last simulation (src/server/sim/engine.ts). */
const BRANCH_TERMS: readonly Term[] = [
  ['NAME', 'the branch and, under it, its mix: percent of capital per coin (SHORT and 3× mark perp legs), "+ DCA" when it buys on a schedule, then the rebalance rule.'],
  ['RETURN%', 'end value against the starting capital in the last simulation, from the branch\'s start date to the latest daily close.'],
  ['MAX DD', 'max drawdown: the deepest fall of the portfolio from an earlier high along the way. Red from 20%.'],
  ['VS BTC', 'how much higher or lower the branch ended than the same capital simply held in BTC over the same days, as a percent of the BTC result.'],
  ['NO REBAL / MONTHLY / WEEKLY / 5% BAND', 'when the weights are reset to target: never, on the first day of each month, once a week, or whenever any weight is more than 5 percentage points off target.'],
  ['UPDATED', 'when the branch was last saved.'],
  ['—', 'the branch has not been simulated yet.'],
]

export function Branches() {
  const { data, loading, error, offline, refetch } = useApi<Branch[]>('/branches')
  const [creating, setCreating] = useState(false)
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

  const columns: Column<Branch>[] = [
    {
      key: 'name',
      label: 'NAME',
      priority: 1,
      render: (b) => (
        <div className="flex flex-col gap-0.5 py-1">
          <span className="text-text-primary">{b.name}</span>
          <span className="text-xs text-text-secondary">
            {allocationSummary(b.config.allocations, b.config.dca)} · {rebalanceLabel(b.config.rebalance)}
          </span>
        </div>
      ),
    },
    {
      key: 'return',
      label: <span title="end value against starting capital in the last simulation">RETURN%</span>,
      priority: 1,
      align: 'right',
      render: (b) =>
        b.result ? (
          <span className={signClass((b.result.stats.finalValue / b.config.initialCapitalUsd - 1) * 100)}>
            {fmtPct(b.result.stats.finalValue / b.config.initialCapitalUsd - 1, { decimals: 1, sign: true })}
          </span>
        ) : (
          <span className="text-text-secondary">—</span>
        ),
    },
    {
      key: 'maxdd',
      label: <span title="max drawdown: deepest fall from an earlier high">MAX DD</span>,
      priority: 2,
      align: 'right',
      render: (b) =>
        b.result ? (
          <span className={maxDdClass(b.result.stats.maxDrawdownPct)}>
            {fmtPct(-Math.abs(b.result.stats.maxDrawdownPct) / 100, { decimals: 1 })}
          </span>
        ) : (
          <span className="text-text-secondary">—</span>
        ),
    },
    {
      key: 'vsbtc',
      label: <span title="end value against the same capital held in BTC, as a percent of the BTC result">VS BTC</span>,
      priority: 3,
      align: 'right',
      render: (b) =>
        b.result ? (
          <span className={signClass(b.result.stats.vsBtcPct)}>
            {fmtPct(b.result.stats.vsBtcPct / 100, { decimals: 1, sign: true })}
          </span>
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
  ]

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">BRANCHES</span>
          <Link to="/analyst?mode=sim" className="text-xs uppercase tracking-wider text-text-secondary hover:text-text-primary ml-auto mr-3">
            SIMULATE →
          </Link>
          <Button tier="neutral" onClick={createBranch} disabled={creating}>
            <span className={creating ? 'pulse-label' : undefined}>{creating ? 'CREATING…' : 'NEW BRANCH'}</span>
          </Button>
        </div>
        <HowToRead terms={BRANCH_TERMS} className="px-3 py-2 border-b border-border-subtle">
          A branch is a what-if portfolio replayed on daily prices from its start date: this much capital, split this way, rebalanced like this. The table shows where each one
          ended up. These are simulations of the past with no fees or funding, not forecasts.
        </HowToRead>
        <div className="panel-body">
          <AsyncBody
            loading={loading}
            data={data}
            error={error}
            offline={offline}
            skeleton={
              <table className="w-full">
                <tbody>
                  <SkeletonRows rows={4} colSpan={columns.length} />
                </tbody>
              </table>
            }
            onRetry={refetch}
          >
            {(rows) => (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(b) => b.id}
                onRowClick={(b) => navigate(`/branches/${b.id}`)}
                emptyLabel={<EmptyBlock label="no branches yet: create one and its simulated return, drawdown and result against BTC list here" action={{ label: 'NEW BRANCH', onClick: createBranch }} />}
              />
            )}
          </AsyncBody>
        </div>
      </div>
    </div>
  )
}
