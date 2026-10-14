import { Badge } from '../Badge'

// VenueBadge — DESIGN-terminal §7.1, the Desk page precedent. PAPER is info;
// TESTNET is amber (a live exchange, even with test funds); null (Desk status
// not landed or unknown) is a gray `VENUE …`. The word is always printed.

export function VenueBadge({ venue }: { venue: 'paper' | 'testnet' | null }) {
  if (venue === 'paper') return <Badge tone="info">PAPER</Badge>
  if (venue === 'testnet') return <Badge tone="amber">TESTNET</Badge>
  return <Badge tone="gray">VENUE …</Badge>
}
