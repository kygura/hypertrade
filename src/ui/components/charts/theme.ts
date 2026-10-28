// Chart theme helpers: read CSS tokens and tint colours for canvas charts.

export function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Scales a hex or rgb(a) color's opacity by `a` (theme tokens may already carry alpha). */
export function alpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
  const m = /rgba?\(([^)]+)\)/.exec(color)
  if (m) {
    const [r, g, b, a0] = m[1]!.split(',').map((x) => x.trim())
    return `rgba(${r},${g},${b},${(a0 == null ? 1 : Number(a0)) * a})`
  }
  return color
}
