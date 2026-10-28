import { useState } from 'react'
import { Button } from '../Button'
import { EmptyBlock } from '../state'

// SqlBlock — DESIGN-terminal §6.2. The compiled SQL, read-only (no raw-SQL
// editing exists, SPEC I4): 11px <pre> on panel-alt, max-height 280px lg /
// 160px mobile, the bound params, ghost COPY. After a DSL edit it dims to 70%
// with `DSL edited — SQL recompiles on RUN`; the RUN response replaces it.

export function SqlBlock({ sql, params, stale }: { sql: string | null; params: (string | number)[] | null; stale: boolean }) {
  const [copied, setCopied] = useState(false)
  if (!sql) return <EmptyBlock label="ask a question, or paste a DSL" />

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked: the text stays selectable
    }
  }

  return (
    <div className="flex flex-col gap-1.5 p-3">
      <div className={`flex flex-col gap-1.5 ${stale ? 'opacity-70' : ''}`}>
        <pre className="text-sm leading-snug whitespace-pre-wrap break-words bg-panel-alt border border-border-subtle p-2 overflow-auto max-h-[160px] lg:max-h-[280px]" aria-label="compiled SQL">
          {sql}
        </pre>
        {params && <p className="text-xs tabular text-text-secondary break-words">params: {JSON.stringify(params)}</p>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-secondary">{stale ? 'DSL edited — SQL recompiles on RUN' : ''}</span>
        <Button tier="ghost" onClick={() => void copy()}>
          {copied ? 'COPIED ✓' : 'COPY'}
        </Button>
      </div>
    </div>
  )
}
