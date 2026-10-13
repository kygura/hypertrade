import { AssetSchema, CHAINS, EvmAddressSchema, HttpsUrlSchema, WatchInputSchema, type Chain, type Watch, type WatchInput } from '../../../shared/intel'

// Pure helpers behind /watch (DESIGN-terminal §8): client validation for
// WatchForm, target shortening and labels for WatchesTable.

export type WatchKind = Watch['kind']

export const KIND_LABEL: Record<WatchKind, string> = { url: 'URL', evm_contract: 'CONTRACT', evm_wallet: 'WALLET' }

export interface WatchFormValues {
  kind: WatchKind
  target: string
  chain: Chain | ''
  asset: string
  label: string
}

export type WatchFormErrors = Partial<Record<keyof WatchFormValues, string>>

export const URL_ERROR = 'enter an https URL'
export const ADDRESS_ERROR = 'enter a 0x address (40 hex)'
export const CHAIN_ERROR = 'choose a chain'
export const ASSET_ERROR = 'enter the exposed asset, e.g. SOL'

/** `0x1234…cdef` for addresses; host + path for URLs. */
export function shortTarget(kind: WatchKind, target: string): string {
  if (kind !== 'url') return /^0x[0-9a-fA-F]{40}$/.test(target) ? `${target.slice(0, 6)}…${target.slice(-4)}` : target
  try {
    const u = new URL(target)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.hostname.replace(/^www\./, '')}${path}`
  } catch {
    return target
  }
}

/**
 * Form → WatchInput, or per-field messages (DESIGN-terminal §8.2 copy). ASSET
 * is required here (the graph entry point) though the contract allows none.
 * Gap: the contract requires `label` while §8.2 makes LABEL optional, so an
 * empty label defaults to the shortened target.
 */
export function validateWatchForm(v: WatchFormValues): { input: WatchInput; errors?: undefined } | { input?: undefined; errors: WatchFormErrors } {
  const errors: WatchFormErrors = {}
  const target = v.target.trim()
  if (v.kind === 'url') {
    if (!HttpsUrlSchema.safeParse(target).success) errors.target = URL_ERROR
  } else {
    if (!EvmAddressSchema.safeParse(target).success) errors.target = ADDRESS_ERROR
    if (!(CHAINS as readonly string[]).includes(v.chain)) errors.chain = CHAIN_ERROR
  }
  const asset = v.asset.trim().toUpperCase()
  if (!asset || !AssetSchema.safeParse(asset).success) errors.asset = ASSET_ERROR
  if (v.label.trim().length > 80) errors.label = 'label up to 80 characters'
  if (Object.keys(errors).length > 0) return { errors }

  const label = v.label.trim() || shortTarget(v.kind, target).slice(0, 80)
  const candidate = v.kind === 'url' ? { kind: v.kind, target, asset, label } : { kind: v.kind, target, chain: v.chain, asset, label }
  const parsed = WatchInputSchema.safeParse(candidate)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const key = (issue?.path[0] as keyof WatchFormValues | undefined) ?? 'target'
    return { errors: { [key]: issue?.message ?? 'invalid' } }
  }
  return { input: parsed.data }
}

/** Hours since the last check, or null when never checked. */
export function checkedAgeHours(w: Pick<Watch, 'checkedAt'>, now = Date.now()): number | null {
  if (!w.checkedAt) return null
  const t = Date.parse(w.checkedAt)
  return Number.isFinite(t) ? (now - t) / 3_600_000 : null
}

/** Unified-diff-ish line → tone: `+` added, `−`/`-` removed, else context. */
export function diffLineKind(line: string): 'add' | 'del' | 'ctx' {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if ((line.startsWith('-') && !line.startsWith('---')) || line.startsWith('−')) return 'del'
  return 'ctx'
}
