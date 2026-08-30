import { Button } from './Button'
import { StatusDot } from './Badge'

// State vocabulary — DESIGN.md §6. Named patterns referenced by name from
// every API-backed surface (see §13 state → view matrix). Loading is
// SkeletonRows only and must resolve to data, EmptyBlock, or ErrorBlock —
// never stay pending forever. No spinners anywhere.

// SkeletonRows (first load) — gray pulse bars of decreasing width. Pass
// `colSpan` to render as <tr>/<td> rows inside a <table> body; omit it for a
// block panel and it renders plain divs instead.
export function SkeletonRows({ rows = 3, colSpan }: { rows?: number; colSpan?: number }) {
  const bars = Array.from({ length: rows }, (_, i) => (
    <div key={i} className="h-3 bg-elevated pulse-label" style={{ width: `${55 - i * 8}%` }} />
  ))
  if (colSpan != null) {
    return (
      <>
        {bars.map((bar, i) => (
          <tr key={i} className="border-b border-border-subtle">
            <td className="px-2 py-2" colSpan={colSpan}>
              {bar}
            </td>
          </tr>
        ))}
      </>
    )
  }
  return <div className="space-y-2 p-2">{bars}</div>
}

// EmptyBlock (loaded, zero items) — centered 11px uppercase text-secondary
// line, optional single ghost action beneath.
export function EmptyBlock({
  label,
  action,
}: {
  label: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 px-3 text-center">
      <span className="text-[11px] uppercase tracking-wider text-text-secondary">{label}</span>
      {action && (
        <Button tier="ghost" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}

// OfflineBlock (API unreachable, no cached data). Never a spinner.
export function OfflineBlock({
  title = 'API UNREACHABLE',
  message = 'check your connection and retry',
  onRetry,
}: {
  title?: string
  message?: string
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 px-3 text-center">
      <StatusDot status="unknown" />
      <span className="text-[11px] uppercase tracking-wider text-text-secondary">{title}</span>
      <span className="text-[10px] text-text-secondary">{message}</span>
      {onRetry && (
        <Button tier="ghost" onClick={onRetry}>
          RETRY
        </Button>
      )}
    </div>
  )
}

// ErrorBlock (request failed with a message) — the verbatim server string,
// never paraphrased.
export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 px-3 py-2 text-[12px] text-red-text bg-red-bg"
    >
      <span className="text-left">{message}</span>
      {onRetry && (
        <Button tier="ghost" onClick={onRetry} className="flex-shrink-0">
          RETRY
        </Button>
      )}
    </div>
  )
}

function ageHours(generatedAt: string): number {
  return (Date.now() - new Date(generatedAt).getTime()) / 3_600_000
}

// StaleBanner (NEW, §6) — full-width strip at panel top, shown when routine
// data age exceeds `thresholdHours`. Content below is NOT dimmed.
export function StaleBanner({
  generatedAt,
  thresholdHours,
  noun,
}: {
  generatedAt: string
  thresholdHours: number
  noun: string
}) {
  if (ageHours(generatedAt) <= thresholdHours) return null
  const hours = Math.floor(ageHours(generatedAt))
  const stamp = new Date(generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  return (
    <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-amber bg-amber-bg border-b border-border-subtle">
      {noun} {hours}h old — generated {stamp}
    </div>
  )
}

// AgeStamp (NEW, §6) — companion pattern: routine-backed panel headers carry
// a right-aligned `GEN 4H AGO`, quiet gray under threshold, amber over it.
export function AgeStamp({ generatedAt, thresholdHours }: { generatedAt: string; thresholdHours: number }) {
  const hours = ageHours(generatedAt)
  const stale = hours > thresholdHours
  const full = new Date(generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  return (
    <span
      className={`text-[10px] tabular ${stale ? 'text-amber' : 'text-text-secondary'}`}
      title={full}
    >
      GEN {Math.floor(hours)}H AGO
    </span>
  )
}
