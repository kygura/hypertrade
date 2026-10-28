import { Badge } from '../Badge'
import { confluenceText, confluenceTitle } from './research'

// ConfluenceBadge — DESIGN-terminal §16.5. A 9px gray `×1.25` suffix after a
// materiality number; nothing at all when the factor is ≤ 1 or absent.

export function ConfluenceBadge({ factor, asset }: { factor: number | undefined; asset: string }) {
  const text = confluenceText(factor)
  if (!text || factor == null) return null
  return (
    <span title={confluenceTitle(factor, asset)}>
      <Badge tone="gray" className="!text-2xs !px-1 !py-0 tabular">
        {text}
      </Badge>
    </span>
  )
}
