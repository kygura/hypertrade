import { useRef, type KeyboardEvent, type ReactNode } from 'react'

// Segmented — one-of-N toggle (timeframes, enums, on/off, theme). A
// radiogroup with roving focus: Tab lands on the checked segment, arrow keys
// move and select, like native radios. Looks come entirely from .seg /
// .seg-item and the --seg-* tokens (index.css), so each theme restyles it
// without touching this file.

export interface SegmentOption<T extends string | number | boolean> {
  value: T
  label: ReactNode
  /** Shorter label shown below md (e.g. in the mobile top strip). */
  short?: ReactNode
  /** Tooltip, e.g. what a mode does. */
  title?: string
  /** Tint the checked segment with a semantic color instead of the neutral fill. */
  tone?: 'green' | 'red'
}

export interface SegmentedProps<T extends string | number | boolean> {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name for the group. */
  label: string
  size?: 'sm' | 'md'
  disabled?: boolean
  id?: string
  className?: string
}

export function Segmented<T extends string | number | boolean>({
  options,
  value,
  onChange,
  label,
  size = 'sm',
  disabled = false,
  id,
  className = '',
}: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const checkedIdx = options.findIndex((o) => o.value === value)
  // With nothing checked, the first segment takes the tab stop.
  const tabStop = checkedIdx === -1 ? 0 : checkedIdx

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    const jump = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null
    if (step == null && jump == null) return
    e.preventDefault()
    const next = jump ?? (tabStop + step! + options.length) % options.length
    refs.current[next]?.focus()
    onChange(options[next]!.value)
  }

  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : onKeyDown}
      className={`seg seg--${size} ${className}`}
    >
      {options.map((o, i) => {
        const checked = i === checkedIdx
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === tabStop ? 0 : -1}
            disabled={disabled}
            title={o.title}
            data-tone={o.tone}
            onClick={() => onChange(o.value)}
            className="seg-item"
          >
            {o.short != null ? (
              <>
                <span className="md:hidden">{o.short}</span>
                <span className="hidden md:inline">{o.label}</span>
              </>
            ) : (
              o.label
            )}
          </button>
        )
      })}
    </div>
  )
}
