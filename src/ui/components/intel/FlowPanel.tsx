import type { HeatmapResponse, HeatmapWindow } from '../../../shared/intel'
import type { IntelState } from '../../lib/intel'
import { Panel, PanelBody, PanelHeader } from '../Panel'
import { Segmented, type SegmentOption } from '../Segmented'
import { SrcTag } from '../SrcTag'
import { AsyncBody, StaleBanner } from '../state'
import { ClaimAge } from './ClaimAge'
import { DetectorChips, type ChipResearchActions } from './DetectorChips'
import { FlowHeatmap } from './FlowHeatmap'

// FlowPanel — DESIGN-terminal §15.1. FLOW · RANKED BY MATERIALITY, the window
// switch (REV | 1H | 6H | 24H), snapshot age; detector chips over the grid.
// A window change refetches in place (no skeleton after first data).

const Z_FIXED = (w: string) => `Δ over ${w} — z against the trailing 30-day distribution of ${w} changes`

export const FLOW_WINDOWS: readonly SegmentOption<HeatmapWindow>[] = [
  { value: 'review', label: 'REV', title: 'since your last review — z against the 7-day history (SPEC I0.4)' },
  { value: '1h', label: '1H', title: Z_FIXED('1h') },
  { value: '6h', label: '6H', title: Z_FIXED('6h') },
  { value: '24h', label: '24H', title: Z_FIXED('24h') },
]

const WINDOW_KEY = 'ht_flow_window'

/** Persisted per browser; storage can throw (private mode) → default REV. */
export function readFlowWindow(): HeatmapWindow {
  try {
    const v = globalThis.localStorage?.getItem(WINDOW_KEY)
    return FLOW_WINDOWS.some((w) => w.value === v) ? (v as HeatmapWindow) : 'review'
  } catch {
    return 'review'
  }
}

export function writeFlowWindow(w: HeatmapWindow): void {
  try {
    globalThis.localStorage?.setItem(WINDOW_KEY, w)
  } catch {
    // storage unavailable: the window just isn't remembered
  }
}

export function FlowPanel({
  state,
  window,
  onWindow,
  research,
}: {
  state: IntelState<HeatmapResponse>
  window: HeatmapWindow
  onWindow: (w: HeatmapWindow) => void
  /** §16.3 chip actions, wired by Terminal. */
  research?: ChipResearchActions
}) {
  const d = state.data
  return (
    <Panel>
      <PanelHeader title="FLOW">
        <span className="label">RANKED BY MATERIALITY</span>
        <Segmented label="flow window" size="sm" options={FLOW_WINDOWS} value={window} onChange={onWindow} />
        {d && (
          <span className="inline-flex items-center gap-1">
            <SrcTag source="snap" />
            <ClaimAge ts={d.asOf} thresholdHours={0.5} />
          </span>
        )}
      </PanelHeader>
      {d && <StaleBanner generatedAt={d.asOf} thresholdHours={2} noun="snapshots" />}
      <PanelBody>
        <AsyncBody
          {...state}
          rows={4}
          empty={{ label: 'nothing held or watched — add a position or watch an asset' }}
          isEmpty={(x) => x.rows.length === 0}
          onRetry={state.refetch}
        >
          {(x) => (
            <>
              <DetectorChips flags={x.flags} materiality={new Map(x.rows.map((r) => [r.asset, r.materiality]))} {...research} />
              <FlowHeatmap data={x} window={window} />
            </>
          )}
        </AsyncBody>
      </PanelBody>
    </Panel>
  )
}
