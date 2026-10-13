import { fmtAge, fmtTs } from '../strategy/format'

// ClaimAge — DESIGN-terminal §2.3. Relative age, 10px tabular: `40S`, `12M`,
// `3H`, `2D` (text from fmtAge without its `AGO`). `title` = full UTC
// timestamp. Amber over `thresholdHours`, text-secondary otherwise. Intel
// uses it instead of AgeStamp, whose whole hours are too coarse for 30 min.

export function claimAgeText(ts: string): string {
  return fmtAge(ts).replace(/ AGO$/, '')
}

export function ClaimAge({ ts, thresholdHours, prefix }: { ts: string; thresholdHours?: number; prefix?: string }) {
  const ageH = (Date.now() - new Date(ts).getTime()) / 3_600_000
  const over = thresholdHours != null && Number.isFinite(ageH) && ageH > thresholdHours
  return (
    <span className={`text-[10px] tabular whitespace-nowrap ${over ? 'text-amber' : 'text-text-secondary'}`} title={fmtTs(ts)}>
      {prefix ? `${prefix} ` : ''}
      {claimAgeText(ts)}
    </span>
  )
}
