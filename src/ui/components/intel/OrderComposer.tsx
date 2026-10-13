import { Button } from '../Button'
import { ErrorBlock } from '../state'

// OrderComposer — DESIGN-terminal §7.3. Textarea + Neutral PREVIEW
// (--control-lg) + fill-only example chips. Enter in the textarea is a
// newline, never a submit: nothing here reaches /order/confirm, and PREVIEW
// only asks the server for a preview.

export const ORDER_EXAMPLES = ["long ETH 3x $1500, stop below yesterday's low", 'short SOL 0.5% of book, stop 2 ATR'] as const

export function OrderComposer({
  text,
  onText,
  onPreview,
  previewing,
  error,
}: {
  text: string
  onText: (text: string) => void
  onPreview: (text: string) => void
  previewing: boolean
  error?: string | null
}) {
  const trimmed = text.trim()
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (trimmed && !previewing) onPreview(trimmed)
      }}
    >
      <label htmlFor="order-text" className="label">
        DESCRIBE THE ORDER
      </label>
      <textarea
        id="order-text"
        rows={4}
        maxLength={500}
        className="w-full resize-y"
        value={text}
        onChange={(e) => onText(e.target.value)}
        spellCheck={false}
      />
      <Button tier="neutral" type="submit" className="h-[var(--control-lg)] w-full md:w-auto md:self-start" disabled={!trimmed || previewing}>
        <span className={previewing ? 'pulse-label' : undefined}>{previewing ? 'PREVIEWING…' : 'PREVIEW'}</span>
      </Button>
      {error && <ErrorBlock message={error} />}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-text-secondary">examples:</span>
        {ORDER_EXAMPLES.map((ex) => (
          <Button key={ex} tier="ghost" type="button" title="fills the box; does not preview" onClick={() => onText(ex)}>
            {ex}
          </Button>
        ))}
      </div>
    </form>
  )
}
