import { Fragment, type ReactNode } from 'react'

// Markdown — the subset analyst answers use: headings, paragraphs, bullet
// and numbered lists, tables, fenced code, block quotes, rules, and inline
// bold / italic / code / links. Builds React elements directly (no HTML
// strings, no dangerouslySetInnerHTML), so model output can never inject
// markup. Links open in a new tab and only http(s) URLs become anchors.
//
// Streaming-safe: an unterminated fence or table renders as what it is so
// far, and the next delta simply re-renders.

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][]; align: Array<'left' | 'right' | 'center'> }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isDivider = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    const fence = /^\s*```(\w*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!)
      i++ // closing fence (or end of a still-streaming block)
      out.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      out.push({ kind: 'heading', level: h[1]!.length, text: h[2]!.trim() })
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: 'rule' })
      i++
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      const head = cells(line)
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') as 'left' | 'right' | 'center')
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!))
      out.push({ kind: 'table', head, rows, align })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      out.push({ kind: 'quote', text: body.join(' ') })
      continue
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line)
      const items: string[] = []
      while (i < lines.length && lines[i]!.trim()) {
        const l = lines[i]!
        if (bullet.test(l)) items.push(l.replace(bullet, ''))
        else if (items.length) items[items.length - 1] += ` ${l.trim()}` // wrapped continuation
        else break
        i++
      }
      out.push({ kind: 'list', ordered, items })
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*```/.test(lines[i]!) &&
      !/^#{1,4}\s/.test(lines[i]!) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!) &&
      !(isTableRow(lines[i]!) && i + 1 < lines.length && isDivider(lines[i + 1]!))
    ) {
      para.push(lines[i++]!.trim())
    }
    out.push({ kind: 'para', text: para.join(' ') })
  }
  return out
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g

/** Inline spans: `code`, **bold**, *italic*, [text](http…). */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(
        <code key={k++} className="px-1 bg-elevated border border-border-subtle text-[0.92em] text-text-primary">
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (tok.startsWith('**')) {
      out.push(
        <strong key={k++} className="text-text-primary font-semibold">
          {inline(tok.slice(2, -2))}
        </strong>,
      )
    } else if (tok.startsWith('*')) {
      out.push(<em key={k++}>{inline(tok.slice(1, -1))}</em>)
    } else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!
      const href = lm[2]!
      out.push(
        /^https?:\/\//i.test(href) ? (
          <a key={k++} href={href} target="_blank" rel="noopener noreferrer" className="text-info underline-offset-2 hover:underline">
            {lm[1]}
          </a>
        ) : (
          lm[1]
        ),
      )
    }
    last = at + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// Signed numbers in table cells pick up the PnL colors, like every other table here.
function cellTone(c: string): string {
  if (/^[+]\s?[$\d.]/.test(c)) return 'text-green'
  if (/^[-−–]\s?[$\d.]/.test(c)) return 'text-red-text'
  return ''
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = parseBlocks(text)
  return (
    <div className={`analyst-md flex flex-col gap-2.5 text-[13px] leading-relaxed text-text-muted break-words ${className}`}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return b.level <= 2 ? (
              <h3 key={i} className="text-[13px] text-text-primary font-semibold mt-1">
                {inline(b.text)}
              </h3>
            ) : (
              <h4 key={i} className="label mt-1">
                {inline(b.text)}
              </h4>
            )
          case 'para':
            return <p key={i}>{inline(b.text)}</p>
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            return (
              <Tag key={i} className={`${b.ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-1 marker:text-text-secondary`}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </Tag>
            )
          }
          case 'table':
            return (
              <div key={i} className="overflow-x-auto border border-border-subtle">
                <table className="w-full text-[12px] tabular">
                  <thead>
                    <tr className="bg-panel-header">
                      {b.head.map((h, j) => (
                        <th key={j} className="px-2 py-1 font-normal text-[10px] text-text-secondary uppercase tracking-wider" style={{ textAlign: b.align[j] ?? 'left' }}>
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-border-subtle">
                        {r.map((c, k) => (
                          <td key={k} className={`px-2 py-1 ${cellTone(c)}`} style={{ textAlign: b.align[k] ?? 'left' }}>
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'code':
            return (
              <pre key={i} className="bg-elevated border border-border-subtle px-2 py-1.5 text-[12px] text-text-primary overflow-x-auto whitespace-pre">
                {b.text}
              </pre>
            )
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-border pl-2 text-text-secondary">
                {inline(b.text)}
              </blockquote>
            )
          case 'rule':
            return <hr key={i} className="border-border-subtle" />
        }
        return <Fragment key={i} />
      })}
    </div>
  )
}
