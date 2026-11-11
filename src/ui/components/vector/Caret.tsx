// ▸ / ▾ for a <details> summary (needs `group` on the <details>), as ChangeEntry draws it.
export function Caret() {
  return (
    <>
      <span aria-hidden="true" className="group-open:hidden">
        ▸
      </span>
      <span aria-hidden="true" className="hidden group-open:inline">
        ▾
      </span>
    </>
  )
}
