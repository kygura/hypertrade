import { useLocation } from 'react-router'
import { LabDataProvider } from '../components/lab/LabData'
import { LabTabs, labTabOf } from '../components/lab/LabTabs'
import { LabSearch } from './LabSearch'
import { LabRuns } from './LabRuns'
import { LabCatalogue } from './LabCatalogue'
import { LabPulse } from './LabPulse'

// /lab — heuristic research (DESIGN.md §10.9, LAB.md). One shell entry; the
// four tabs are paths (/lab/search, /lab/runs[/:runId], /lab/catalogue,
// /lab/pulse) under one sticky Segmented. The rule drill (/lab/rules/:id) is
// its own full-view route (LabRule.tsx). Nothing here trades.

export function Lab() {
  const { pathname } = useLocation()
  const tab = labTabOf(pathname)
  return (
    <LabDataProvider>
      <div className="max-w-[1440px] mx-auto px-3 pb-3 md:px-[var(--gutter)] md:pb-[var(--gutter)] flex flex-col">
        <LabTabs />
        {tab === 'search' && <LabSearch />}
        {tab === 'runs' && <LabRuns />}
        {tab === 'catalogue' && <LabCatalogue />}
        {tab === 'pulse' && <LabPulse />}
      </div>
    </LabDataProvider>
  )
}
