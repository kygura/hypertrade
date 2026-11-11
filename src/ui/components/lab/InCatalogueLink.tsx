import { Link } from 'react-router'

// In place of SAVE when the rule is already in the catalogue (the server says so: the study's `catalogueId`, the
// evaluation's `id` against the catalogue list). /lab/study and the ad-hoc rule drill both render it.
export function InCatalogueLink({ id }: { id: string }) {
  return (
    <Link
      to={`/lab/rules/${encodeURIComponent(id)}`}
      title="this rule is saved: open its catalogue entry"
      className="btn inline-flex items-center h-[var(--control-md)] px-2.5 rounded-control border border-border text-xs text-text-secondary hover:text-text-primary hover:bg-hover"
    >
      IN CATALOGUE →
    </Link>
  )
}
