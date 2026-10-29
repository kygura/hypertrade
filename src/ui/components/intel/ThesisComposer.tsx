import { useId, useState } from 'react'
import type { Thesis } from '../../../shared/intel'
import { intel } from '../../lib/intel'
import { Button } from '../Button'
import { ErrorBlock } from '../state'
import { useAction } from './useAction'

// ThesisComposer — DESIGN-terminal §5.2. `.label THESIS`, textarea (8 rows,
// ≤ 2000 chars), Neutral `STRESS-TEST` at --control-lg (POST /theses; up to
// ~30 s). Failure → verbatim ErrorBlock under the button: 503 `llm not
// configured`, 429 `LLM cap reached`, 502 model failures, 400 zod messages.

export const THESIS_MAX = 2000
const PLACEHOLDER = 'HYPE grinds higher into the unlock because perp OI keeps rising while funding stays flat'

export function ThesisComposer({ onCreated }: { onCreated: (t: Thesis) => void }) {
  const id = useId()
  const [text, setText] = useState('')
  const action = useAction((t: string) => intel.createThesis(t))

  const submit = async () => {
    const t = await action.run(text.trim())
    if (t) {
      setText('')
      onCreated(t)
    }
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <label htmlFor={id} className="label">
        THESIS
      </label>
      <textarea
        id={id}
        rows={8}
        maxLength={THESIS_MAX}
        value={text}
        placeholder={PLACEHOLDER}
        onChange={(e) => setText(e.target.value)}
        disabled={action.busy}
        className="w-full resize-y text-base"
      />
      <span className="text-xs tabular text-text-secondary self-end">
        {text.length}/{THESIS_MAX}
      </span>
      <Button tier="neutral" className="h-[var(--control-lg)] w-full" onClick={() => void submit()} disabled={action.busy || !text.trim()}>
        <span className={action.busy ? 'pulse-label' : undefined}>{action.busy ? 'EXTRACTING…' : 'STRESS-TEST'}</span>
      </Button>
      {action.busy && <p className="text-xs text-text-secondary">the model extracts claims, code checks each one — up to ~30 s</p>}
      {action.error && <ErrorBlock message={action.error} onRetry={() => void submit()} />}
    </div>
  )
}
