import { ClaimLine, type LineClaim } from './ClaimLine'

// ClaimList — DESIGN-terminal §2.4. An <ol> of ClaimLines, 6px row gap, in
// server order (never re-sorted). Footer only when the trace reports dropped
// lines. No list ever mixes claim lines with untagged prose.

export function droppedText(n: number): string {
  return `${n} ${n === 1 ? 'line' : 'lines'} dropped — no source or tag`
}

export function ClaimList({ claims, dropped }: { claims: LineClaim[]; dropped?: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      {claims.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {claims.map((c, i) => (
            <ClaimLine key={i} claim={c} as="li" />
          ))}
        </ol>
      )}
      {dropped != null && dropped > 0 && <p className="text-xs text-text-secondary">{droppedText(dropped)}</p>}
    </div>
  )
}
