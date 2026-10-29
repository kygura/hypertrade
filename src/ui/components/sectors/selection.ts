// One selection for /sectors: the heat grid (/sectors payload) and the narratives
// table (/intel/narratives payload) are keyed by the same basket id but come from
// different payloads with different freshness. An id present in only one payload
// still resolves there; the other side is null (its panel shows an empty state).

export function toggleSelection(cur: string | null, id: string): string | null {
  return cur === id ? null : id
}

export function resolveSelection<S extends { id: string }, N extends { id: string }>(
  selectedId: string | null,
  sectors: readonly S[] | undefined,
  narratives: readonly N[] | undefined,
): { sector: S | null; narrative: N | null } {
  if (!selectedId) return { sector: null, narrative: null }
  return {
    sector: sectors?.find((s) => s.id === selectedId) ?? null,
    narrative: narratives?.find((n) => n.id === selectedId) ?? null,
  }
}
