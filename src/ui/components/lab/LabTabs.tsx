import { SectionTabs, type SectionTab } from '../SectionTabs'
import { useLabDataOptional } from './LabData'

// LabTabs — the RESEARCH family row (docs/design/README.md §10.9): workflow order
// BOARD · STUDY · RULES · BRANCHES (docs/RESEARCH.md), a SectionTabs wrapper. SEARCH, RUNS and PULSE are
// hidden from the row (docs/TASKS.md 2026-11-11) and show only on their own pages. Sticky under
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

/** Every path of the RESEARCH family: the board `/board`, /lab/* and /branches/*. */
export function isResearchPath(p: string): boolean {
  return p === '/board' || p === '/lab' || p.startsWith('/lab/') || p === '/branches' || p.startsWith('/branches/')
}

export function LabTabs({ pulseFiring }: { pulseFiring?: boolean } = {}) {
  const data = useLabDataOptional()
  const count = data?.catalogue.data?.length
  // Unknown until a pulse is loaded (here or on the board): no dot, a neutral title, never "not firing".
  const firing: boolean | undefined = data?.pulse.data ? data.pulse.data.assets.some((a) => a.rules.some((r) => r.firing)) : pulseFiring
  const inLab = (tab: LabTab) => (p: string) => p.startsWith('/lab') && labTabOf(p) === tab

  const tabs: SectionTab[] = [
    { to: '/board', label: 'BOARD', short: 'BRD', title: 'live signals with their evidence', match: (p) => p === '/board' },
    { to: '/lab/study', label: 'STUDY', short: 'STDY', title: 'event study: one rule replayed as past trades across coins', match: inLab('study') },
    { to: '/lab/search', label: 'SEARCH', short: 'SRCH', title: 'search for simple rules on one asset', match: inLab('search'), hidden: true },
    { to: '/lab/runs', label: 'RUNS', short: 'RUNS', title: 'stored searches', match: inLab('runs'), hidden: true },
    { to: '/lab/catalogue', label: count != null ? `RULES · ${count}` : 'RULES', short: 'RULE', title: 'the rule catalogue: rules you saved and how they have done since', match: inLab('catalogue') },
    {
      to: '/lab/pulse',
      label: (
        <>
          PULSE
          {firing && <span className="sr-only"> · rule firing</span>}
        </>
      ),
      dot: firing,
      title: firing === undefined ? 'pulse not loaded' : firing ? 'a catalogued rule is firing' : 'no catalogued rule is firing',
      match: inLab('pulse'),
      hidden: true,
    },
    { to: '/branches', label: 'BRANCHES', short: 'BRNCH', title: 'what-if portfolios replayed on past prices', match: (p) => p === '/branches' || p.startsWith('/branches/') },
  ]
  return <SectionTabs label="research sections" tabs={tabs} />
}
