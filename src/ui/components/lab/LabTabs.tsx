import { SectionTabs, type SectionTab } from '../SectionTabs'
import { useLabDataOptional } from './LabData'

// LabTabs — the RESEARCH family row (docs/design/README.md §10.9): workflow order
// BOARD · STUDY · SEARCH · RUNS · CATALOGUE · PULSE · BRANCHES (docs/RESEARCH.md), a SectionTabs wrapper. Sticky under
// the top bar; the row is --subnav-h tall (the lg search form sticks under both). Inside the Lab it reads the
// LabDataProvider (catalogue count, pulse dot); on the board there is no provider, so no Lab load starts and
// the dot comes from the board's own pulse counts (`pulseFiring`).

export type LabTab = 'study' | 'search' | 'runs' | 'catalogue' | 'pulse'

export function labTabOf(pathname: string): LabTab {
  if (pathname.startsWith('/lab/study')) return 'study'
  if (pathname.startsWith('/lab/runs/')) return 'search'
  if (pathname.startsWith('/lab/runs')) return 'runs'
  if (pathname.startsWith('/lab/catalogue')) return 'catalogue'
  if (pathname.startsWith('/lab/pulse')) return 'pulse'
  return 'search'
}

/** Every path of the RESEARCH family: the board `/`, /lab/* and /branches/*. */
export function isResearchPath(p: string): boolean {
  return p === '/' || p === '/lab' || p.startsWith('/lab/') || p === '/branches' || p.startsWith('/branches/')
}

export function LabTabs({ pulseFiring }: { pulseFiring?: boolean } = {}) {
  const data = useLabDataOptional()
  const count = data?.catalogue.data?.length
  const firing = data?.pulse.data ? data.pulse.data.assets.some((a) => a.rules.some((r) => r.firing)) : (pulseFiring ?? false)
  const inLab = (tab: LabTab) => (p: string) => p.startsWith('/lab') && labTabOf(p) === tab

  const tabs: SectionTab[] = [
    { to: '/', label: 'BOARD', short: 'BRD', title: 'live signals with their evidence', match: (p) => p === '/' },
    { to: '/lab/study', label: 'STUDY', short: 'STDY', match: inLab('study') },
    { to: '/lab/search', label: 'SEARCH', short: 'SRCH', match: inLab('search') },
    { to: '/lab/runs', label: 'RUNS', short: 'RUNS', match: inLab('runs') },
    { to: '/lab/catalogue', label: count != null ? `CATALOGUE · ${count}` : 'CATALOGUE', short: 'CTLG', match: inLab('catalogue') },
    {
      to: '/lab/pulse',
      label: (
        <>
          PULSE
          {firing && <span className="sr-only"> · rule firing</span>}
        </>
      ),
      dot: firing,
      title: firing ? 'a catalogued rule is firing' : 'no catalogued rule is firing',
      match: inLab('pulse'),
    },
    { to: '/branches', label: 'BRANCHES', short: 'BRNCH', match: (p) => p === '/branches' || p.startsWith('/branches/') },
  ]
  return <SectionTabs label="research sections" tabs={tabs} />
}
