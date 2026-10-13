import { Panel, PanelHeader, PanelBody } from '../../components'
import { EmptyBlock } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'

// `/order` — order copilot: preview, then the operator's confirm, then the
// Desk venue (DESIGN-terminal §7). Nothing executes from this scaffold.
// filled by U4 — scaffold only.

export function Order() {
  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <Panel>
        <PanelHeader title="DESCRIBE" />
        <PanelBody>
          <EmptyBlock label="coming online" />
        </PanelBody>
      </Panel>
    </div>
  )
}
