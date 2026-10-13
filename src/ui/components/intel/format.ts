// Formatting for the Intel tool surfaces (DESIGN-terminal §4–§6). Every
// computed number prints its sign (DESIGN §2.1); the minus is U+2212.
// Timestamps are UTC.

const MINUS = '−'

/** Signed number: `+1.40`, `−0.38`, `0.00`. */
export function fmtSignedNum(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const v = Number(n.toFixed(decimals))
  const body = Math.abs(v).toFixed(decimals)
  return v > 0 ? `+${body}` : v < 0 ? `${MINUS}${body}` : body
}

/** Signed R multiple: `+1.4R`. */
export function fmtR(r: number | null | undefined, decimals = 1): string {
  return r == null || !Number.isFinite(r) ? '—' : `${fmtSignedNum(r, decimals)}R`
}

/** Signed percent from an already-scaled percent number: `−3.2%`. */
export function fmtPctNum(p: number | null | undefined, decimals = 1): string {
  return p == null || !Number.isFinite(p) ? '—' : `${fmtSignedNum(p, decimals)}%`
}

/** Signed USD: `+$12.30`, `−$4.00`. */
export function fmtUsdSigned2(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const body = `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return n > 0 ? `+${body}` : n < 0 ? `${MINUS}${body}` : body
}

/** Hold duration: `45M`, `3H`, `2D 4H`. */
export function fmtHold(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}M`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}H`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d}D ${rh}H` : `${d}D`
}

/** `MM-DD HH:mm` in UTC. */
export function fmtMdHm(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(5, 16).replace('T', ' ')
}

/** Compact price level: `$79.2K`, `$1.25M`, `$0.0123`. */
export function fmtLevel(n: number): string {
  const abs = Math.abs(n)
  const trim = (x: number, d: number) => String(Number(x.toFixed(d)))
  let body: string
  if (abs >= 1e9) body = `${trim(abs / 1e9, 2)}B`
  else if (abs >= 1e6) body = `${trim(abs / 1e6, 2)}M`
  else if (abs >= 1e3) body = `${trim(abs / 1e3, 2)}K`
  else if (abs >= 1) body = trim(abs, 2)
  else body = String(Number(abs.toPrecision(3)))
  return `${n < 0 ? MINUS : ''}$${body}`
}

/** Comparison operators typeset: `>=` → `≥`. */
export function fmtOp(op: string): string {
  return op === '>=' ? '≥' : op === '<=' ? '≤' : op === '!=' ? '≠' : op
}

/** Tailwind class for a signed value (green / red / quiet). The sign always prints too. */
export function signClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return 'text-text-secondary'
  return n > 0 ? 'text-green' : 'text-red-text'
}
