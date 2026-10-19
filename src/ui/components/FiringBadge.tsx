import { Badge } from './Badge'

// FiringBadge — docs/design/README.md §10.9/§11. `● FIRING` green / `○ FLAT` gray; the
// dot is a text glyph and the word always ships with it.

export function FiringBadge({ firing, className = '' }: { firing: boolean; className?: string }) {
  return (
    <Badge tone={firing ? 'green' : 'gray'} className={className}>
      <span aria-hidden="true">{firing ? '●' : '○'}</span>
      {firing ? 'FIRING' : 'FLAT'}
    </Badge>
  )
}
