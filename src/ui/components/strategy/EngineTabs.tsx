import { SectionTabs } from '../SectionTabs'

// EngineTabs — sub-navigation for the strategy console. The shell keeps one
// nav entry (ENGINE → /strategies); the three console routes switch here.

const TABS = [
  { to: '/strategies', label: 'STRATEGIES', short: 'STRAT' },
  { to: '/decisions', label: 'DECISIONS', short: 'DECS' },
  { to: '/governor', label: 'GOVERNOR', short: 'GOV' },
]

export function EngineTabs() {
  return <SectionTabs label="engine" tabs={TABS} />
}
