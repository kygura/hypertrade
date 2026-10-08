import { createContext, useContext, type ReactNode } from 'react'
import { lab, useLab, type CatalogueListEntry, type LabState, type MarketPulse, type MetricDef } from '../../lib/lab'

// Data the four /lab tabs share: the metric catalogue (RuleText names, the
// picker), the saved rules (CATALOGUE count, SAVED ✓) and the pulse (the
// PULSE tab dot, FIRING cells). Loaded once per visit to the tabbed view.

interface LabData {
  metrics: LabState<MetricDef[]>
  catalogue: LabState<CatalogueListEntry[]>
  pulse: LabState<MarketPulse>
}

const Ctx = createContext<LabData | null>(null)

export function LabDataProvider({ children }: { children: ReactNode }) {
  const metrics = useLab(() => lab.metrics(), [])
  const catalogue = useLab(() => lab.catalogue(), [])
  const pulse = useLab(() => lab.pulse(), [])
  return <Ctx.Provider value={{ metrics, catalogue, pulse }}>{children}</Ctx.Provider>
}

export function useLabData(): LabData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useLabData outside LabDataProvider')
  return v
}

/** Rule ids currently firing per the pulse (null while unknown). */
export function firingIds(pulse: MarketPulse | null): Map<string, boolean> | null {
  if (!pulse) return null
  const m = new Map<string, boolean>()
  for (const a of pulse.assets) for (const r of a.rules) m.set(r.id, r.firing)
  return m
}
