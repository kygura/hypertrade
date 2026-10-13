import { useMemo, useState } from 'react'
import { Badge, Panel, PanelHeader } from '../../components'
import { EmptyBlock, SkeletonRows } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'
import { DslEditor, prettyDsl, validateDsl } from '../../components/intel/DslEditor'
import { QueryInput } from '../../components/intel/QueryInput'
import { QueryRunBar } from '../../components/intel/QueryRunBar'
import { ResultTable } from '../../components/intel/ResultTable'
import { SqlBlock } from '../../components/intel/SqlBlock'
import { useAction } from '../../components/intel/useAction'
import { intel } from '../../lib/intel'
import type { QueryParseResponse, QueryResult } from '../../../shared/intel'

// `/query` — ask the snapshot store in words, see exactly what ran
// (DESIGN-terminal §6). QUESTION → DSL (editable JSON) → SQL (read-only) →
// RUN → RESULT. The SQL shown always belongs to a known DSL text: after an
// edit it dims until RUN returns the recompiled statement. A failed run keeps
// the prior result at 70%. Mobile order: question, DSL, SQL, run, result.

const RESULT_LIMIT = 500

interface Compiled {
  sql: string
  /** Bound params, known only for the DSL text the parse compiled (the run response carries none). */
  params: (string | number)[] | null
  /** The DSL text this SQL was compiled from. */
  from: string
}

export function Query() {
  const [dslText, setDslText] = useState('')
  const [compiled, setCompiled] = useState<Compiled | null>(null)
  const [result, setResult] = useState<QueryResult | null>(null)
  const validation = useMemo(() => validateDsl(dslText), [dslText])
  const run = useAction(intel.runQuery)

  const onParsed = (r: QueryParseResponse) => {
    const text = prettyDsl(r.dsl)
    setDslText(text)
    setCompiled({ sql: r.sql, params: r.params, from: text })
  }

  const onRun = async () => {
    if (validation.kind !== 'valid') return
    const text = dslText
    const r = await run.run(validation.dsl)
    if (r) {
      setResult(r)
      setCompiled((c) => ({ sql: r.sql, params: c && c.from === text && c.sql === r.sql ? c.params : null, from: text }))
    }
  }

  const sqlStale = compiled != null && compiled.from !== dslText
  const failedOverPrior = result != null && (run.error != null || run.offline)

  let resultBody
  if (!result) resultBody = run.busy ? <SkeletonRows rows={4} /> : <EmptyBlock label="run a query" />
  else if (result.rows.length === 0) resultBody = <EmptyBlock label="0 rows" />
  else
    resultBody = (
      <div className={run.busy || failedOverPrior ? 'opacity-70' : undefined}>
        <ResultTable columns={result.columns} rows={result.rows} />
      </div>
    )

  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        <Panel className="lg:col-span-12">
          <PanelHeader title="QUESTION" />
          <QueryInput onParsed={onParsed} />
        </Panel>

        <Panel className="lg:col-span-7 min-w-0">
          <PanelHeader title="DSL (EDITABLE JSON)" />
          <DslEditor value={dslText} onChange={setDslText} error={validation.kind === 'invalid' ? validation.error : null} />
        </Panel>

        <Panel className="lg:col-span-5 min-w-0">
          <PanelHeader title="SQL (READ-ONLY)" />
          <SqlBlock sql={compiled?.sql ?? null} params={compiled?.params ?? null} stale={sqlStale} />
        </Panel>

        <Panel className="lg:col-span-12">
          <QueryRunBar validation={validation} running={run.busy} onRun={() => void onRun()} error={run.error} offline={run.offline} />
        </Panel>

        <Panel className="lg:col-span-12 min-w-0">
          <PanelHeader title={result ? `RESULT · ${result.rows.length} ROWS · ${Math.round(result.ms)} MS` : 'RESULT'}>
            {result && result.rows.length >= RESULT_LIMIT && <Badge tone="amber">LIMIT {RESULT_LIMIT}</Badge>}
          </PanelHeader>
          {resultBody}
        </Panel>
      </div>
    </div>
  )
}
