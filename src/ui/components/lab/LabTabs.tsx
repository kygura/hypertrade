import { SectionTabs, type SectionTab } from '../SectionTabs'
import { useLabData } from './LabData'

// LabTabs — the RESEARCH family row (docs/design/README.md §10.9): workflow order
// SEARCH · RUNS · CATALOGUE · PULSE · BRANCHES, a SectionTabs wrapper. Sticky under
// the top bar; the row is --subnav-h tall (the lg search form sticks under both).

export type LabTab = 'search' | 'runs' | 'catalogue' | 'pulse'

export function labTabOf(pathname: string): LabTab {
  if (pathname.startsWith('/lab/runs/')) return 'search'
  if (pathname.startsWith('/lab/runs')) return 'runs'
  if (pathname.startsWith('/lab/catalogue')) return 'catalogue'
  if (pathname.startsWith('/lab/pulse')) return 'pulse'
  return 'search'
}

export function LabTabs() {
  const { catalogue, pulse } = useLabData()
  const count = catalogue.data?.length
  const firing = pulse.data?.assets.some((a) => a.rules.some((r) => r.firing)) ?? false
  const inLab = (tab: LabTab) => (p: string) => !p.startsWith('/branches') && labTabOf(p) === tab

  const tabs: SectionTab[] = [
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
