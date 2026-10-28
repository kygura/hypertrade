import { Panel, PanelBody, PanelHeader } from '../Panel'
import { AsyncBody } from '../state'
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
        <AsyncBody loading data={assets} error={null} rows={2} empty={{ label: 'hold a position to see its exposure' }}>
          {(held) => held.map((a, i) => <ExposureAssetRow key={a} asset={a} defaultOpen={i === 0} />)}
        </AsyncBody>
      </PanelBody>
    </Panel>
  )
}
