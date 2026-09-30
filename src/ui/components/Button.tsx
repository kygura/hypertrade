import { forwardRef, type ButtonHTMLAttributes } from 'react'

// Button — DESIGN.md §3. Three tiers (money/arm dropped: no execution paths
// in this product).
//   ghost   — nav, filters, cancel, retry, secondary actions
//   neutral — primary submits: login, save/create branch, run simulation,
//             trigger routine
//   danger  — delete branch, remove allocation row (confirmed per §7)
export type ButtonTier = 'ghost' | 'neutral' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tier: ButtonTier
}

const BASE =
  'btn inline-flex items-center justify-center gap-1.5 rounded-control ' +
  'font-control [text-transform:var(--control-case)] tracking-[var(--control-tracking)] font-[number:var(--control-weight)] ' +
  'transition-colors duration-100 disabled:cursor-not-allowed'

const TIER_CLASS: Record<ButtonTier, string> = {
  ghost:
    'h-[var(--control-md)] px-2.5 text-[10px] border border-border text-text-secondary ' +
    'hover:text-text-primary hover:bg-hover active:bg-active ' +
    'disabled:text-text-disabled disabled:border-border-subtle',
  neutral:
    'h-[var(--control-md)] px-2.5 text-[10px] border border-border bg-primary text-on-primary ' +
    'hover:bg-primary-hover active:bg-active ' +
    'disabled:text-text-disabled disabled:border-border-subtle disabled:bg-transparent',
  danger:
    'h-[var(--control-md)] px-2.5 text-[10px] border border-border text-red-text ' +
    'hover:bg-red-bg active:bg-active ' +
    'disabled:text-text-disabled disabled:border-border-subtle',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tier, className = '', disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`${BASE} btn--${tier} ${TIER_CLASS[tier]} ${className}`}
      disabled={disabled}
      {...props}
    />
  )
})
