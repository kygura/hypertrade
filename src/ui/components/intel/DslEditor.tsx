import { useId } from 'react'
import { ScreenerDslSchema, type ScreenerDsl } from '../../../shared/intel'
import { isDesktop } from './format'

// DslEditor — DESIGN-terminal §6.2. The parsed DSL pretty-printed in an
// editable monospace textarea (14 rows lg / 10 mobile, spellcheck off), with
// a validity line under it: `✓ valid JSON` or `✗ <error>` (red-text).
// The page validates with `validateDsl` — JSON syntax first, then the shared
// ScreenerDslSchema (unknown columns, bad ops, limits) — and keeps RUN
// disabled until it passes; the server's zod stays the authority.

export type DslValidation = { kind: 'empty' } | { kind: 'invalid'; error: string } | { kind: 'valid'; dsl: ScreenerDsl }

function jsonErrorText(text: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/line \d+/i.test(msg)) return msg
  const pos = /position (\d+)/i.exec(msg)
  if (pos) {
    const line = text.slice(0, Number(pos[1])).split('\n').length
    return `line ${line}: ${msg.replace(/^JSON\.parse:\s*/i, '')}`
  }
  return msg
}

export function validateDsl(text: string): DslValidation {
  if (!text.trim()) return { kind: 'empty' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { kind: 'invalid', error: jsonErrorText(text, err) }
  }
  const r = ScreenerDslSchema.safeParse(raw)
  if (!r.success) {
    const issue = r.error.issues[0]
    const path = issue?.path.join('.')
    return { kind: 'invalid', error: `${path ? `${path}: ` : ''}${issue?.message ?? 'invalid DSL'}` }
  }
  return { kind: 'valid', dsl: r.data }
}

export function prettyDsl(dsl: unknown): string {
  return JSON.stringify(dsl, null, 2)
}

export function DslEditor({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string | null }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5 p-3">
      <label htmlFor={id} className="sr-only">
        screener DSL as JSON
      </label>
      <textarea
        id={id}
        rows={isDesktop() ? 14 : 10}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y font-mono text-[12px] leading-snug"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-validity`}
      />
      <p id={`${id}-validity`} className={`text-[11px] break-words ${error ? 'text-red-text' : 'text-text-secondary'}`}>
        {error ? `✗ ${error}` : value.trim() ? '✓ valid JSON' : ''}
      </p>
    </div>
  )
}
