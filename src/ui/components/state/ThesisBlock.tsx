import type { MarketStateThesis } from '../../../shared/types'
import { Panel, PanelHeader, PanelBody } from '../Panel'

// ThesisBlock — DESIGN.md §10.6. Observe/Infer/Forecast, each an xs
// uppercase label followed by muted body text, disclaimer verbatim beneath.

const SECTIONS = [
  { key: 'observe', label: 'OBSERVE' },
  { key: 'infer', label: 'INFER' },
  { key: 'forecast', label: 'FORECAST' },
] as const

export function ThesisBlock({ thesis }: { thesis: MarketStateThesis }) {
  return (
    <Panel>
      <PanelHeader title="THESIS" />
      <PanelBody className="p-3 flex flex-col gap-3">
        {SECTIONS.map(({ key, label }) => (
          <div key={key}>
            <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">{label}</div>
            <p className="text-[13px] text-text-muted">{thesis[key]}</p>
          </div>
        ))}
        <p className="text-[10px] text-text-secondary">{thesis.disclaimer}</p>
      </PanelBody>
    </Panel>
  )
}
