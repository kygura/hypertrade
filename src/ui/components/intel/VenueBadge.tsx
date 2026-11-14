import { Badge } from '../Badge'

// VenueBadge — DESIGN-terminal §7.1, the Desk page precedent. PAPER is info;
// TESTNET and PROPR are amber (a live exchange: test funds, or a Propr account
// on mainnet); null (Desk status not landed or unknown) is a gray `VENUE …`.
// The word is always printed.

export function VenueBadge({ venue }: { venue: 'paper' | 'testnet' | 'propr' | null }) {
  if (venue === 'paper') return <Badge tone="info">PAPER</Badge>
  if (venue === 'testnet') return <Badge tone="amber">TESTNET</Badge>
  if (venue === 'propr') return <Badge tone="amber">PROPR</Badge>
  return <Badge tone="gray">VENUE …</Badge>
}
