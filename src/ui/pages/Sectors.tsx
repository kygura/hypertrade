import { useEffect, useRef, useState } from 'react'
import { Panel, PanelHeader, PanelBody } from '../components/Panel'
import { AgeStamp, StaleBanner, SkeletonRows, EmptyBlock, ErrorBlock } from '../components/state'
import { useApi } from '../lib/api'
import { MindshareGrid, type EnrichedSector } from '../components/sectors/MindshareGrid'
import { RotationsPanel } from '../components/sectors/RotationsPanel'
import { SectorDrillPanel } from '../components/sectors/SectorDrillPanel'
import type { SectorsData } from '../../shared/types'

// /sectors — DESIGN.md §10.5. Desktop 12-col: MINDSHARE 8 / ROTATIONS 4,
// DRILL-IN full-width below when a sector is selected. Mobile: grid, then
// drill-in (scrolled into view), then rotations.

type SectorsResponse = Omit<SectorsData, 'sectors'> & { sectors: EnrichedSector[] }

export function Sectors() {
  const { data, loading, error, refetch } = useApi<SectorsResponse>('/sectors')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const drillRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selectedId) drillRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const selected = data?.sectors.find((s) => s.id === selectedId) ?? null
  const sectorLabel = (id: string) => data?.sectors.find((s) => s.id === id)?.label.toUpperCase() ?? id.toUpperCase()

  return (
    <div className="max-w-[1440px] mx-auto p-3 md:p-[var(--gutter)] flex flex-col gap-3 lg:grid lg:grid-cols-12 lg:gap-3">
      <Panel className="lg:col-span-8">
        {data && <StaleBanner generatedAt={data.generated_at} thresholdHours={24} noun="sector data" />}
        <PanelHeader title="MINDSHARE">{data && <AgeStamp generatedAt={data.generated_at} thresholdHours={24} />}</PanelHeader>
        <PanelBody>
          {loading && <SkeletonRows />}
          {error && <ErrorBlock message={error} onRetry={refetch} />}
          {data && data.sectors.length === 0 && <EmptyBlock label="no sector data yet — trigger the routine from STATE" />}
          {data && data.sectors.length > 0 && (
            <MindshareGrid
              sectors={data.sectors}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
            />
          )}
        </PanelBody>
      </Panel>

      {selected && (
        <div ref={drillRef} className="order-2 lg:order-none lg:col-span-12">
          <Panel>
            <SectorDrillPanel sector={selected} onClose={() => setSelectedId(null)} />
          </Panel>
        </div>
      )}

      <Panel className="order-3 lg:order-none lg:col-span-4">
        <PanelHeader title="ROTATIONS" />
        <PanelBody>
          {loading && <SkeletonRows />}
          {data && <RotationsPanel rotations={data.rotations} sectorLabel={sectorLabel} />}
        </PanelBody>
      </Panel>
    </div>
  )
}
