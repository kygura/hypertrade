// SrcTag — DESIGN.md §2/§11. Source-attribution tag: HL / CG / FRED / ROUTINE / ELFA.
// `.src-tag` in index.css; `hl` gets the jade accent (`.src-tag--hl`).

export type Source = 'hl' | 'cg' | 'fred' | 'routine' | 'elfa'

const LABEL: Record<Source, string> = {
  hl: 'HL',
  cg: 'CG',
  fred: 'FRED',
  routine: 'ROUTINE',
  elfa: 'ELFA',
}

export function SrcTag({ source, className = '' }: { source: Source; className?: string }) {
  return (
    <span className={`src-tag ${source === 'hl' ? 'src-tag--hl' : ''} ${className}`}>
      {LABEL[source]}
    </span>
  )
}
