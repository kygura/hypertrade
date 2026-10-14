import { Link } from 'react-router'
import { SrcTag } from '../SrcTag'

// SourceLink — DESIGN-terminal §2.2. `.src-tag` styling with the source label:
// internal url (`/markets/HYPE`) → router Link; external http(s) url → new
// tab + ` ↗`; no url → the plain tag. Snapshot facts (`label: "snapshot"`)
// render SNAP. Source urls can be model-written, so anything that is not a
// same-origin path or an http(s) URL renders as the plain tag (no
// `javascript:` or protocol-relative hrefs).

export interface SourceRef {
  label: string
  url?: string
}

export function sourceHref(url: string | undefined): { kind: 'internal' | 'external'; href: string } | null {
  if (!url) return null
  if (url.startsWith('/') && !url.startsWith('//')) return { kind: 'internal', href: url }
  if (/^https?:\/\//i.test(url)) return { kind: 'external', href: url }
  return null
}

// .src-tag is unlayered CSS (it wins over color utilities); underline is the hover cue.
const LINK = 'hover:underline'

export function SourceLink({ source }: { source: SourceRef }) {
  const snap = source.label.trim().toLowerCase() === 'snapshot'
  const link = sourceHref(source.url)

  if (snap) {
    const tag = <SrcTag source="snap" />
    if (!link) return tag
    return link.kind === 'internal' ? (
      <Link to={link.href} className="inline-flex" aria-label="snapshot">
        {tag}
      </Link>
    ) : (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5">
        {tag} <span aria-hidden="true" className="text-[9px] text-text-secondary">↗</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    )
  }

  if (!link) return <span className="src-tag">{source.label}</span>
  if (link.kind === 'internal') {
    return (
      <Link to={link.href} className={`src-tag ${LINK}`}>
        {source.label}
      </Link>
    )
  }
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={`src-tag ${LINK}`}>
      {source.label} <span aria-hidden="true">↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
