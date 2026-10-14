// TradeIdLinks — DESIGN-terminal §4.2/§11. 9px boxed chips of trade ids;
// real links (`href="?trade=<id>"`) so they open in a new tab too, while a
// plain click selects in place (the page widens the window and scrolls).

export function TradeIdLinks({ ids, onPick }: { ids: string[]; onPick: (id: string) => void }) {
  if (ids.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1" aria-label="trades behind this finding">
      {ids.map((id) => (
        <li key={id}>
          <a
            href={`?trade=${encodeURIComponent(id)}`}
            className="src-tag hover:underline"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              onPick(id)
            }}
          >
            {id}
          </a>
        </li>
      ))}
    </ul>
  )
}
