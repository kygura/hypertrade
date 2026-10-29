import { useEffect, useRef, useState } from 'react'
import { Panel, PanelHeader, PanelBody } from '../components/Panel'
import { AgeStamp, AsyncBody, EmptyBlock, StaleBanner } from '../components/state'
import { useApi } from '../lib/api'
import { resolveSelection, toggleSelection } from '../components/sectors/selection'
import { MindshareGrid, type EnrichedSector } from '../components/sectors/MindshareGrid'
import { RotationsPanel } from '../components/sectors/RotationsPanel'
import { SectorDrillPanel } from '../components/sectors/SectorDrillPanel'
import { NarrativesPanel } from '../components/sectors/NarrativesPanel'
import type { NarrativesResponse } from '../../shared/intel'
import type { SectorsData } from '../../shared/types'

// /sectors — docs/design/README.md §10.5. Desktop 12-col: NARRATIVES full-width
// (docs/SPEC.md § Narratives), then MINDSHARE 8 / ROTATIONS 4, DRILL-IN full-width
// below when a sector is selected. Mobile: narratives, grid, then drill-in
// (scrolled into view), then rotations.

type SectorsResponse = Omit<SectorsData, 'sectors'> & { sectors: EnrichedSector[] }

export function Sectors() {
  const { data, loading, error, offline, refetch } = useApi<SectorsResponse>('/sectors')
  const narratives = useApi<NarrativesResponse>('/intel/narratives')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const drillRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selectedId) drillRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const { sector: selected } = resolveSelection(selectedId, data?.sectors, narratives.data?.narratives)
  const select = (id: string) => setSelectedId((cur) => toggleSelection(cur, id))
  const sectorLabel = (id: string) => data?.sectors.find((s) => s.id === id)?.label.toUpperCase() ?? id.toUpperCase()

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3 lg:grid lg:grid-cols-12 lg:gap-3">
      <Panel className="lg:col-span-12">
        <PanelHeader title="NARRATIVES">{narratives.data && <AgeStamp generatedAt={narratives.data.sectorsAsOf} thresholdHours={24} />}</PanelHeader>
        <PanelBody>
          <AsyncBody {...narratives} staleError={false} onRetry={narratives.refetch}>
            {(d) => <NarrativesPanel data={d} selectedId={selectedId} onSelect={select} onChanged={narratives.refetch} />}
          </AsyncBody>
        </PanelBody>
      </Panel>

      <Panel className="lg:col-span-8">
        {data && <StaleBanner generatedAt={data.generated_at} thresholdHours={24} noun="sector data" />}
        <PanelHeader title="MINDSHARE">{data && <AgeStamp generatedAt={data.generated_at} thresholdHours={24} />}</PanelHeader>
        <PanelBody>
          <AsyncBody
            loading={loading}
            data={data}
            error={error}
            offline={offline}
            staleError={false}
            empty={{ label: 'no sector data yet — trigger the routine from STATE' }}
            isEmpty={(d) => d.sectors.length === 0}
            onRetry={refetch}
          >
            {(d) => <MindshareGrid sectors={d.sectors} selectedId={selectedId} onSelect={select} />}
          </AsyncBody>
        </PanelBody>
      </Panel>

      {selectedId && (
        <div ref={drillRef} className="order-2 lg:order-none lg:col-span-12">
          <Panel>
            {selected ? (
              <SectorDrillPanel sector={selected} onClose={() => setSelectedId(null)} />
            ) : (
              <EmptyBlock label="no sector data for this narrative" />
            )}
          </Panel>
        </div>
      )}

      <Panel className="order-3 lg:order-none lg:col-span-4">
        <PanelHeader title="ROTATIONS" />
        <PanelBody>
          <AsyncBody loading={loading} data={data} error={null}>
            {(d) => <RotationsPanel rotations={d.rotations} sectorLabel={sectorLabel} />}
          </AsyncBody>
        </PanelBody>
      </Panel>
    </div>
  )
}
