import { useState } from 'react'
import type { Allocation, BranchConfig } from '../../../shared/types'
import { isPerp } from '../../../shared/schemas'
import type { SimBranchOutcome, SimResult } from '../../../shared/intent'
import { fmtPct, fmtUsd } from '../../../shared/format'
import type { SimResultEvent } from '../../lib/analyst'
import { Badge, Button, DataTable, ErrorBlock, LabWarnings, SkeletonRows, type Column } from '..'
import { DrawdownChart } from '../branches/DrawdownChart'
import { maxDdClass, rebalanceLabel, signClass } from '../branches/format'
import { EquityChart } from '../charts/EquityChart'
import { ProjectionAssumptions } from '../charts/FanChart'
import { SaveBranchButton } from './SaveBranchButton'

// PathCard family — DESIGN-chat §2/§3/§5. One card per sim_result event;
// PathCompare picks the branch, PathBranch shows it.

const LETTERS = 'ABCD'
const pct1 = (n: number, sign = true) => fmtPct(n / 100, { decimals: 1, sign })
const returnPct = (r: SimResult, cfg: BranchConfig) => (r.stats.finalValue / cfg.initialCapitalUsd - 1) * 100
const fmtLev = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

function PathLegs({ config }: { config: BranchConfig }) {
  const leg = (a: Allocation) => {
    const lev = a.leverage ?? 1
    const perp = isPerp(a)
    return (
      <span key={a.coin} className="inline-flex items-center gap-1">
        {a.coin} {Number(a.weightPct.toFixed(1))}%{perp && <Badge tone="gray">{`${a.side === 'short' ? 'SHORT' : 'LONG'} ${fmtLev(lev)}×`}</Badge>}
      </span>
    )
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-x-1 text-[11px] text-text-primary">
        {config.allocations.map((a, i) => (
          <span key={a.coin + i} className="inline-flex items-center gap-1">
            {i > 0 && <span>·</span>}
            {leg(a)}
          </span>
        ))}
      </div>
      {config.dca && config.dca.length > 0 && (
        <div className="text-[11px] text-text-muted">
          DCA {config.dca.map((d) => `${fmtUsd(d.amountUsd, { decimals: 0 })} → ${d.coin} ${d.every.toUpperCase()}`).join(' · ')}
        </div>
      )}
      <div className="text-[10px] text-text-secondary">
        FROM {config.startDate} · {fmtUsd(config.initialCapitalUsd, { decimals: 0 })} · {rebalanceLabel(config.rebalance)}
      </div>
    </div>
  )
}

function Cell({ label, className, children }: { label: string; className?: string; children: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="label">{label}</span>
      <span className={`tabular ${className ?? 'text-text-primary'}`}>{children}</span>
    </div>
  )
}

function PathStats({ result, config }: { result: SimResult; config: BranchConfig }) {
  const s = result.stats
  const ret = returnPct(result, config)
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <Cell label="FINAL">{fmtUsd(s.finalValue, { decimals: 0 })}</Cell>
      <Cell label="RETURN" className={signClass(ret)}>{pct1(ret)}</Cell>
      <Cell label="CAGR" className={signClass(s.cagrPct)}>{pct1(s.cagrPct)}</Cell>
      <Cell label="MAX DD" className={maxDdClass(s.maxDrawdownPct)}>{pct1(-Math.abs(s.maxDrawdownPct), false)}</Cell>
      <Cell label="VS BTC" className={signClass(s.vsBtcPct)}>{pct1(s.vsBtcPct)}</Cell>
    </div>
  )
}

function PathBranch({
  branch,
  letter,
  title,
  assumptions,
  savedId,
  onSaved,
  onFork,
}: {
  branch: SimBranchOutcome
  letter: string
  title: string
  assumptions: string[]
  savedId?: string
  onSaved: (id: string) => void
  onFork: () => void
}) {
  const { config, result } = branch
  const description = `Paths: ${title}.${assumptions.length ? ` Assumed: ${assumptions.join('; ')}.` : ''}`
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-text-primary min-w-0 basis-full md:basis-0 md:flex-1 break-words">
          {letter} · {branch.name}
        </span>
        {!branch.error && <SaveBranchButton name={branch.name} config={config} description={description} savedId={savedId} onSaved={onSaved} />}
        <Button tier="ghost" type="button" onClick={onFork} className="flex-1 md:flex-none">
          FORK
        </Button>
      </div>
      <PathLegs config={config} />
      <LabWarnings warnings={branch.warnings} />
      {branch.error && <ErrorBlock message={branch.error} />}
      {result && !branch.error && (
        <>
          <PathStats result={result} config={config} />
          <EquityChart equity={result.equity} btc={result.benchmarks.btc} usdc={result.benchmarks.usdc} projection={result.montecarlo} height={220} />
          {result.montecarlo && config.scenario && <ProjectionAssumptions scenario={config.scenario} />}
          <div className="flex items-baseline justify-between">
            <span className="label">DRAWDOWN</span>
            <span className={`text-[11px] tabular ${maxDdClass(result.stats.maxDrawdownPct)}`}>MAX DD {pct1(-Math.abs(result.stats.maxDrawdownPct), false)}</span>
          </div>
          <DrawdownChart equity={result.equity} height={90} />
        </>
      )}
    </div>
  )
}

type Row = { b: SimBranchOutcome; i: number }

function PathCompare({ branches, selected, onSelect }: { branches: SimBranchOutcome[]; selected: number; onSelect: (i: number) => void }) {
  const rows: Row[] = branches.map((b, i) => ({ b, i }))
  const num = (row: Row, v: (r: SimResult) => number, cls: (n: number) => string) => {
    const r = row.b.result
    return r && !row.b.error ? <span className={cls(v(r))}>{pct1(v(r))}</span> : '—'
  }
  const columns: Column<Row>[] = [
    {
      key: 'path',
      label: 'PATH',
      priority: 1,
      render: ({ b, i }) => (
        <span className="whitespace-normal">
          <span aria-hidden="true">{i === selected ? '▸' : ' '}</span> {LETTERS[i]} {b.name}
          {b.error ? (
            <>
              {' '}
              <Badge tone="red">FAILED</Badge>
            </>
          ) : (
            b.warnings.length > 0 && <span className="text-[10px] text-amber"> {b.warnings.length} WARN</span>
          )}
        </span>
      ),
    },
    { key: 'ret', label: 'RETURN', priority: 1, align: 'right', render: (row) => num(row, (r) => returnPct(r, row.b.config), signClass) },
    {
      key: 'dd',
      label: 'MAX DD',
      priority: 2,
      align: 'right',
      render: (row) => {
        const r = row.b.result
        return r && !row.b.error ? <span className={maxDdClass(r.stats.maxDrawdownPct)}>{pct1(-Math.abs(r.stats.maxDrawdownPct), false)}</span> : '—'
      },
    },
    { key: 'btc', label: 'VS BTC', priority: 3, align: 'right', render: (row) => num(row, (r) => r.stats.vsBtcPct, signClass) },
  ]
  return <DataTable columns={columns} rows={rows} rowKey={(r) => String(r.i)} onRowClick={(r) => onSelect(r.i)} isSelected={(r) => r.i === selected} />
}

export function PathCard({
  sim,
  saved,
  onSaved,
  onFork,
}: {
  sim: SimResultEvent
  saved: Record<string, string>
  onSaved: (key: string, branchId: string) => void
  onFork: (name: string) => void
}) {
  const { intent, branches } = sim
  const [sel, setSel] = useState(() => Math.max(0, branches.findIndex((b) => !b.error)))
  const branch = branches[sel] ?? branches[0]
  if (!branch) return null
  const key = `${sim.id}#${sel}`
  return (
    <section className="panel" aria-label={`Simulation: ${intent.title}`}>
      <div className="panel-header">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="panel-title">SIM</span>
          <span className="text-[12px] text-text-primary break-words">{intent.title}</span>
        </span>
        <span className="text-[10px] text-text-secondary shrink-0">{branches.length === 1 ? '1 PATH' : `${branches.length} PATHS`}</span>
      </div>
      <div className="panel-body bg-panel-alt">
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <span className="label">ASSUMED</span>
          {intent.assumptions.length === 0 ? (
            <span className="text-[11px] text-text-muted">· nothing inferred — every input was stated</span>
          ) : (
            intent.assumptions.map((a, i) => (
              <span key={i} className="text-[11px] text-text-muted">
                · {a}
              </span>
            ))
          )}
        </div>
        {branches.length > 1 && (
          <div className="border-t border-border-subtle">
            <PathCompare branches={branches} selected={sel} onSelect={setSel} />
          </div>
        )}
        <div className="border-t border-border-subtle">
          <PathBranch
            key={key}
            branch={branch}
            letter={LETTERS[sel] ?? ''}
            title={intent.title}
            assumptions={intent.assumptions}
            savedId={saved[key]}
            onSaved={(id) => onSaved(key, id)}
            onFork={() => onFork(branch.name)}
          />
        </div>
      </div>
    </section>
  )
}

/** Shell shown while simulate_paths runs (DESIGN-chat §2.7). */
export function PathPending({ input }: { input: unknown }) {
  const o = (input && typeof input === 'object' ? input : {}) as { title?: unknown; branches?: unknown }
  return (
    <section className="panel" aria-busy="true">
      <div className="panel-header">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="panel-title">SIM</span>
          {typeof o.title === 'string' && <span className="text-[12px] text-text-primary break-words">{o.title}</span>}
        </span>
        <span className="text-[10px] text-text-secondary pulse-label shrink-0">
          {Array.isArray(o.branches) ? `SIMULATING ${o.branches.length} PATHS…` : 'SIMULATING…'}
        </span>
      </div>
      <div className="panel-body bg-panel-alt p-3">
        <SkeletonRows rows={3} />
      </div>
    </section>
  )
}
