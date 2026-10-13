import { Panel, PanelHeader, PanelBody } from '../../components'
import { EmptyBlock } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'

// `/watch` — doc/contract/wallet watches (DESIGN-terminal §8); `?id=`.
// filled by U4 — scaffold only.

export function Watch() {
  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <Panel>
        <PanelHeader title="WATCHES" />
        <PanelBody>
          <EmptyBlock label="coming online" />
        </PanelBody>
      </Panel>
    </div>
  )
}
