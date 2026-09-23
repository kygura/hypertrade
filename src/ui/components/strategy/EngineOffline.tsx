import { OfflineBlock } from '../state'

// EngineOffline — DESIGN.md §6 OfflineBlock with the proxy's verbatim reason.
// "engine not configured" is configuration state (ENGINE_URL unset), so the
// copy says what to set; anything else is the unreachable case.

export function EngineOffline({ reason, onRetry }: { reason: string; onRetry?: () => void }) {
  const notConfigured = /not configured/i.test(reason)
  return (
    <OfflineBlock
      title={notConfigured ? 'ENGINE NOT CONFIGURED' : 'ENGINE UNREACHABLE'}
      message={notConfigured ? 'set ENGINE_URL on the server and retry' : reason}
      onRetry={onRetry}
    />
  )
}

// OfflineStrip — shown above cached data when a later poll failed: the last
// good data stays visible, undimmed (old data is still the real latest data).
export function OfflineStrip({ reason, fetchedAt }: { reason: string; fetchedAt: number | null }) {
  const stamp = fetchedAt ? new Date(fetchedAt).toISOString().slice(11, 16) + ' UTC' : '—'
  return (
    <div
      role="status"
      className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-amber bg-amber-bg border-b border-border-subtle"
    >
      {reason} — showing data from {stamp}
    </div>
  )
}
