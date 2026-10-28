import { useId, useState, type KeyboardEvent } from 'react'
import type { QueryParseResponse } from '../../../shared/intel'
import { intel } from '../../lib/intel'
import { Button } from '../Button'
import { ErrorBlock, OfflineBlock } from '../state'
import { useAction } from './useAction'

// QueryInput — DESIGN-terminal §6.2. `.label QUESTION`, a one-line field that
// wraps to 3 rows past 80 chars, Neutral PARSE (POST /query/parse,
// `PARSING…`), Enter submits. Three ghost example chips fill the input and
// never auto-run. Parse failures render verbatim under the question: 503
// `llm not configured`, 429 `LLM cap reached`, 502 model/compile errors.

export const QUERY_EXAMPLES = ['held coins with widest spread today', 'OI up >20% in 7d', 'funding flipped negative in the last 24h'] as const
const WRAP_AT = 80

export function QueryInput({ onParsed }: { onParsed: (r: QueryParseResponse) => void }) {
  const id = useId()
  const [q, setQ] = useState('')
  const action = useAction((question: string) => intel.parseQuery(question))
  const canParse = q.trim().length > 0 && !action.busy

  const submit = async () => {
    if (!canParse) return
    const r = await action.run(q.trim())
    if (r) onParsed(r)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <label htmlFor={id} className="label">
        QUESTION
      </label>
      <div className="flex items-start gap-2">
        {/* One line until it passes 80 chars, then it wraps (one element, so focus and caret survive). */}
        <textarea
          id={id}
          value={q}
          maxLength={500}
          rows={q.length > WRAP_AT ? 3 : 1}
          placeholder="Which watched coins had funding z above 2 and OI up 10% in 24h?"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          className="w-full min-w-0 resize-none"
        />
        <Button tier="neutral" onClick={() => void submit()} disabled={!canParse} className="flex-shrink-0">
          <span className={action.busy ? 'pulse-label' : undefined}>{action.busy ? 'PARSING…' : 'PARSE'}</span>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-text-secondary">examples:</span>
        {QUERY_EXAMPLES.map((ex) => (
          <Button key={ex} tier="ghost" onClick={() => setQ(ex)}>
            {ex}
          </Button>
        ))}
      </div>
      {action.offline ? (
        <OfflineBlock onRetry={() => void submit()} />
      ) : (
        action.error && <ErrorBlock message={action.error} onRetry={() => void submit()} />
      )}
    </div>
  )
}
