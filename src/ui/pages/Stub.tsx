import { Panel, PanelHeader, PanelBody } from '../components/Panel'
import { EmptyBlock } from '../components/state'

// View-independent stub — route title + EmptyBlock. Real content lands in
// T9/T10/T11 (Overview+Markets, Branches, Sectors+State).

export function Stub({ title, label }: { title: string; label: string }) {
  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)]">
      <Panel>
        <PanelHeader title={title} />
        <PanelBody>
          <EmptyBlock label={label} />
        </PanelBody>
      </Panel>
    </div>
  )
}
