import { Panel, PanelHeader, PanelBody } from '../../components'
import { EmptyBlock } from '../../components/state'
import { TerminalTabs } from '../../components/intel/TerminalTabs'

// `/` — TERMINAL (DESIGN-terminal §3): "what changed since I last looked that
// could affect my positions?". Owns the brief POST (reviewThrottle in
// lib/intel.ts) and `?review=1` (§1.5).
// filled by U2 — scaffold only.

export function Terminal() {
  return (
    <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
      <TerminalTabs />
      <Panel>
        <PanelHeader title="WHAT CHANGED" />
        <PanelBody>
          <EmptyBlock label="coming online" />
        </PanelBody>
      </Panel>
    </div>
  )
}
