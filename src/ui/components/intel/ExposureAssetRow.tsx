import { useState } from 'react'
import { intel, INTEL_POLL_MS, useIntel } from '../../lib/intel'
import { ErrorBlock, OfflineBlock, SkeletonRows } from '../state'
import { ExposureGraph } from './ExposureGraph'

// ExposureAssetRow — DESIGN-terminal §3.8 / §15.6. Collapsed `▸ SOL · 9 EDGES
// · 4 PATHS` (aria-expanded), a disclosure around ExposureGraph; expanding
// fetches GET /graph?asset= and refreshes every 10 min while open.

export function ExposureAssetRow({ asset, defaultOpen = false }: { asset: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const graph = useIntel(() => intel.graph(asset), [asset], { enabled: open, intervalMs: INTEL_POLL_MS.graph })
  const g = graph.data
  const panelId = `exposure-${asset}`

  return (
    <div className="border-b border-border-subtle last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 min-h-[var(--row-h)] text-left text-[12px] hover:bg-hover"
      >
        <span aria-hidden="true" className="text-text-secondary w-[1ch]">
          {open ? '▾' : '▸'}
        </span>
        <span className="text-text-primary">{asset}</span>
        {g && (
          <span className="text-[10px] tabular text-text-secondary">
            · {g.edges.length} EDGES · {g.paths.length} PATHS
          </span>
        )}
      </button>
      {open && (
        <div id={panelId} className="px-3 pb-3">
          {graph.offline && !g ? (
            <OfflineBlock message={graph.offline} onRetry={graph.refetch} />
          ) : graph.error && !g ? (
            <ErrorBlock message={graph.error} onRetry={graph.refetch} />
          ) : !g ? (
            <SkeletonRows rows={2} />
          ) : (
            <>
              {graph.error && <ErrorBlock message={graph.error} onRetry={graph.refetch} />}
              <ExposureGraph asset={asset} edges={g.edges} paths={g.paths} onChanged={graph.refetch} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
