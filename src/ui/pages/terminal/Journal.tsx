import { Panel, PanelHeader, PanelBody } from '../../components'
import { EmptyBlock } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'

// `/journal` — what my own trades say (DESIGN-terminal §4); `?trade=`, `?tag=`.
// filled by U3 — scaffold only.

export function Journal() {
  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <Panel>
        <PanelHeader title="JOURNAL" />
        <PanelBody>
          <EmptyBlock label="coming online" />
        </PanelBody>
      </Panel>
    </div>
  )
}
