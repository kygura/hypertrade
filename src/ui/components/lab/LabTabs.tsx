import { useLocation, useNavigate } from 'react-router'
import { Segmented, type SegmentOption } from '../Segmented'
import { useLabData } from './LabData'

// LabTabs — DESIGN.md §10.9. One Segmented (md) under the shell, workflow
// order SEARCH · RUNS · CATALOGUE · PULSE, path-based so each tab is a
// bookmarkable page. Sticky under the 40px top bar; the row is 52px tall
// (the lg search form sticks at 92px under it).

export type LabTab = 'search' | 'runs' | 'catalogue' | 'pulse'

export function labTabOf(pathname: string): LabTab {
  if (pathname.startsWith('/lab/runs/')) return 'search'
  if (pathname.startsWith('/lab/runs')) return 'runs'
  if (pathname.startsWith('/lab/catalogue')) return 'catalogue'
  if (pathname.startsWith('/lab/pulse')) return 'pulse'
  return 'search'
}

export function LabTabs() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { catalogue, pulse } = useLabData()
  const count = catalogue.data?.length
  const firing = pulse.data?.assets.some((a) => a.rules.some((r) => r.firing)) ?? false

  const options: SegmentOption<LabTab>[] = [
    { value: 'search', label: 'SEARCH', short: 'SRCH' },
    { value: 'runs', label: 'RUNS', short: 'RUNS' },
    { value: 'catalogue', label: count != null ? `CATALOGUE · ${count}` : 'CATALOGUE', short: 'CTLG' },
    {
      value: 'pulse',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 ${firing ? 'bg-green' : 'bg-text-secondary/40'}`} />
          PULSE
        </span>
      ),
      title: firing ? 'a catalogued rule is firing' : 'no catalogued rule is firing',
    },
  ]

  return (
    <div className="sticky top-10 z-30 h-[52px] flex items-center bg-body">
      <Segmented
        label="lab sections"
        size="md"
        options={options}
        value={labTabOf(pathname)}
        onChange={(t) => navigate(`/lab/${t}`)}
      />
    </div>
  )
}
