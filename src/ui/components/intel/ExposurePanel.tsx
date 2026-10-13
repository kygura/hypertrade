import { Panel, PanelBody, PanelHeader } from '../Panel'
import { EmptyBlock, SkeletonRows } from '../state'
import { ExposureAssetRow } from './ExposureAssetRow'

// ExposurePanel — DESIGN-terminal §3.8. One row per held asset (watch-only
// excluded), sorted by notional desc by the caller; the first is expanded on
// load. `assets` null = positions not loaded yet.

export function ExposurePanel({ assets }: { assets: string[] | null }) {
  return (
    <Panel>
      <PanelHeader title="EXPOSURE">
        <span className="label">HELD ASSETS · 1–2 HOPS</span>
      </PanelHeader>
      <PanelBody>
        {assets == null ? (
          <SkeletonRows rows={2} />
        ) : assets.length === 0 ? (
          <EmptyBlock label="hold a position to see its exposure" />
        ) : (
          assets.map((a, i) => <ExposureAssetRow key={a} asset={a} defaultOpen={i === 0} />)
        )}
      </PanelBody>
    </Panel>
  )
}
