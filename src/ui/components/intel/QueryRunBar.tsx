import { Button } from '../Button'
import { ErrorBlock, OfflineBlock } from '../state'
import type { DslValidation } from './DslEditor'

// QueryRunBar — DESIGN-terminal §6.2 "RUN" row (a Query* component per §14).
// Neutral RUN at --control-lg, the view's primary action (POST /query/run,
// `RUNNING…`), disabled while the DSL is empty, not JSON, or rejected by the
// shared ScreenerDslSchema. Constraint line beside it. Run failures render
// verbatim under it (zod paths, timeouts, Postgres messages, the 503 when the
// database is not configured); no HTTP response → OfflineBlock.

export function canRun(v: DslValidation, running: boolean): boolean {
  return v.kind === 'valid' && !running
}

export function QueryRunBar({
  validation,
  running,
  onRun,
  error,
  offline = false,
}: {
  validation: DslValidation
  running: boolean
  onRun: () => void
  error?: string | null
  offline?: boolean
}) {
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <Button tier="neutral" className="h-[var(--control-lg)] px-6" onClick={onRun} disabled={!canRun(validation, running)}>
          <span className={running ? 'pulse-label' : undefined}>{running ? 'RUNNING…' : 'RUN'}</span>
        </Button>
        <span className="text-xs text-text-secondary">read-only · 5 s timeout · ≤ 500 rows · ≤ 90 days</span>
      </div>
      {offline ? <OfflineBlock onRetry={onRun} /> : error && <ErrorBlock message={error} onRetry={canRun(validation, running) ? onRun : undefined} />}
    </div>
  )
}
