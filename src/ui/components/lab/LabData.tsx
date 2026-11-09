import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { lab, useLab, type CatalogueListEntry, type LabState, type MarketPulse, type MetricDef } from '../../lib/lab'

// Data the /lab tabs share: the metric catalogue (RuleText names, the
// picker), the saved rules (CATALOGUE count, SAVED ✓) and the pulse (the
// PULSE tab dot, FIRING cells). Metrics and catalogue load once per visit to
// the tabbed view; the pulse (it evaluates every saved rule) loads only once a
// page that shows it asks via usePulse(), and the tab dot reads it from then on.

interface LabData {
  metrics: LabState<MetricDef[]>
  catalogue: LabState<CatalogueListEntry[]>
  /** Idle (no data, not loading) until a page calls usePulse(). */
  pulse: LabState<MarketPulse>
  wantPulse: () => void
}

const Ctx = createContext<LabData | null>(null)

export function LabDataProvider({ children }: { children: ReactNode }) {
  const metrics = useLab(() => lab.metrics(), [])
  const catalogue = useLab(() => lab.catalogue(), [])
  const [pulseOn, setPulseOn] = useState(false)
  const pulse = useLab(pulseOn ? () => lab.pulse() : null, [pulseOn])
  return <Ctx.Provider value={{ metrics, catalogue, pulse, wantPulse: () => setPulseOn(true) }}>{children}</Ctx.Provider>
}

export function useLabData(): LabData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useLabData outside LabDataProvider')
  return v
}

/** The pulse for a page that shows it: starts the provider's load on mount; reads as loading until the first result. */
export function usePulse(): LabState<MarketPulse> {
  const { pulse, wantPulse } = useLabData()
  useEffect(wantPulse, []) // eslint-disable-line react-hooks/exhaustive-deps
  const idle = pulse.data == null && !pulse.loading && pulse.error == null && !pulse.offline
  return idle ? { ...pulse, loading: true } : pulse
}

/** Rule ids currently firing per the pulse (null while unknown). */
export function firingIds(pulse: MarketPulse | null): Map<string, boolean> | null {
  if (!pulse) return null
  const m = new Map<string, boolean>()
  for (const a of pulse.assets) for (const r of a.rules) m.set(r.id, r.firing)
  return m
}
