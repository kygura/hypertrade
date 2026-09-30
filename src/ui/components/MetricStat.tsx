// MetricStat — DESIGN.md §10.2/§11. One metrics-strip cell: label / value /
// signed delta with z30 eyebrow (amber when |z| >= 2 — an unusual reading).

export function MetricStat({
  label,
  value,
  delta,
  deltaPositive,
  z30,
}: {
  label: string
  value: string
  delta?: string | null
  deltaPositive?: boolean | null
  z30?: number | null
}) {
  const showZ = z30 != null && Math.abs(z30) >= 1
  const zWarn = z30 != null && Math.abs(z30) >= 2

  return (
    <div className="metric flex flex-col gap-1 p-3 min-w-0">
      <span className="metric-label text-[10px] text-text-secondary [text-transform:var(--label-case)] tracking-[var(--label-tracking)] font-[number:var(--label-weight)]">{label}</span>
      <span className="metric-value text-[16px] tabular text-text-primary truncate">{value}</span>
      {delta != null && (
        <span
          className={`text-[10px] tabular ${
            deltaPositive == null ? 'text-text-secondary' : deltaPositive ? 'text-green' : 'text-red-text'
          }`}
        >
          {delta}
          {showZ && <span className={zWarn ? 'text-amber' : 'text-text-secondary'}> z{z30!.toFixed(1)}</span>}
        </span>
      )}
    </div>
  )
}
