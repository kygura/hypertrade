import { Panel, PanelHeader, PanelBody } from '../../components'
import { EmptyBlock } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'

// `/query` — NL → DSL → SQL → result over the snapshot store (DESIGN-terminal §6).
// filled by U3 — scaffold only.

export function Query() {
  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <Panel>
        <PanelHeader title="QUESTION" />
        <PanelBody>
          <EmptyBlock label="coming online" />
        </PanelBody>
      </Panel>
    </div>
  )
}
