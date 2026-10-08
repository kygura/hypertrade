// SrcTag — DESIGN.md §2/§11. Source-attribution tag: HL / CG / FRED / ROUTINE / ELFA,
// plus the four lab providers (§10.9: HT / CM / FNG / LLAMA, gray like CG).
// `.src-tag` in index.css; `hl` gets the jade accent (`.src-tag--hl`).

export type Source = 'hl' | 'cg' | 'fred' | 'routine' | 'elfa' | 'ht' | 'cm' | 'fng' | 'llama'

const LABEL: Record<Source, string> = {
  hl: 'HL',
  cg: 'CG',
  fred: 'FRED',
  routine: 'ROUTINE',
  elfa: 'ELFA',
  ht: 'HT',
  cm: 'CM',
  fng: 'FNG',
  llama: 'LLAMA',
}

export function SrcTag({ source, className = '' }: { source: Source; className?: string }) {
  return (
    <span className={`src-tag ${source === 'hl' ? 'src-tag--hl' : ''} ${className}`}>
      {LABEL[source]}
    </span>
  )
}
