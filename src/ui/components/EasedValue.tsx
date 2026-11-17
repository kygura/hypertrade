import { useState } from 'react'

// EasedValue — a refreshed number settles into place instead of ticking: when
// `value` changes after mount, the text re-mounts with a 400 ms opacity ease
// (.value-ease in index.css). No colour, no flash, nothing on first paint.

export function EasedValue({ value, className = '' }: { value: string; className?: string }) {
  // Derive the change count from the previous render (React's "store info from previous renders" pattern).
  const [seen, setSeen] = useState({ value, gen: 0 })
  let gen = seen.gen
  if (seen.value !== value) {
    gen += 1
    setSeen({ value, gen })
  }
  return (
    <span key={gen} className={`${gen > 0 ? 'value-ease' : ''} ${className}`.trim() || undefined}>
      {value}
    </span>
  )
}
