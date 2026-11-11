import { ErrorBlock, OfflineBlock, SkeletonRows } from '../components/state'
import { useApi } from '../lib/api'
import { VectorView } from '../components/vector/VectorView'
import type { VectorResponse } from '../../shared/vector'

// /htf — HTF view, the hl-cycles BTC Vector regime screen: regime and allocation,
// four gauges, the regime-coloured price chart, the market compass, key
// cost-basis levels, the brief, macro context and source health. The payload
// moves once a day; a failed refetch keeps the last body on screen.

export function Vector() {
  const { data: body, loading, error, offline, refetch } = useApi<VectorResponse>('/vector')

  if (!body) {
    return (
      <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3">
        {loading && (
          <div className="flex flex-col gap-2">
            <SkeletonRows />
            <span className="text-xs text-text-secondary text-center pulse-label">loading BTC regime…</span>
          </div>
        )}
        {!loading && offline && <OfflineBlock onRetry={refetch} />}
        {!loading && !offline && error && <ErrorBlock message={error} onRetry={refetch} />}
      </div>
    )
  }

  return <VectorView vector={body} refreshing={loading} />
}
