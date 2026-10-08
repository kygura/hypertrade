// LabWarnings — DESIGN.md §10.9/§11. Full-width amber-bg strip, one row per
// engine warning with a 6px amber square bullet, verbatim 11px text-primary
// (sentences, so not the uppercase StaleBanner idiom). Nothing when empty.

export function LabWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null
  return (
    <ul aria-label="warnings" className="bg-amber-bg px-3 py-1.5 flex flex-col gap-1">
      {warnings.map((w, i) => (
        <li key={i} className="flex items-start gap-2 text-sm text-text-primary">
          <span aria-hidden="true" className="mt-[5px] inline-block w-1.5 h-1.5 flex-shrink-0 bg-amber" />
          <span>{w}</span>
        </li>
      ))}
    </ul>
  )
}
