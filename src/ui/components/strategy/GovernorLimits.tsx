// Governor limit inputs shared by /governor (global settings, all required) and a
// strategy's override (blank = inherit). Values stay strings until save.

export const LIMIT_KEYS = ['min_confidence', 'max_notional_usd', 'max_open_intents'] as const
export type LimitKey = (typeof LIMIT_KEYS)[number]
export type LimitForm = Record<LimitKey, string>

const LIMIT_FIELDS: readonly (readonly [LimitKey, string, string, string | undefined, string])[] = [
  ['min_confidence', 'MIN CONFIDENCE', '0', '1', '0.01'],
  ['max_notional_usd', 'MAX NOTIONAL (USD)', '0', undefined, '1'],
  ['max_open_intents', 'MAX OPEN INTENTS', '0', undefined, '1'],
]

/** Field errors for the three limits. `allowBlank` skips empty fields (override inherits them). */
export function governorLimitErrors(f: LimitForm, { allowBlank }: { allowBlank: boolean }): Partial<Record<LimitKey, string>> {
  const e: Partial<Record<LimitKey, string>> = {}
  const num = (key: LimitKey) => {
    if (f[key].trim() === '') return allowBlank ? null : NaN
    return Number(f[key])
  }
  const mc = num('min_confidence')
  if (mc != null && (Number.isNaN(mc) || mc < 0 || mc > 1)) e.min_confidence = 'must be between 0 and 1'
  const mn = num('max_notional_usd')
  if (mn != null && (Number.isNaN(mn) || mn < 0)) e.max_notional_usd = 'must be ≥ 0'
  const mo = num('max_open_intents')
  if (mo != null && (Number.isNaN(mo) || mo < 0 || !Number.isInteger(mo))) e.max_open_intents = 'must be a whole number ≥ 0'
  return e
}

export function GovernorLimitFields({
  form,
  errors,
  onChange,
  placeholder,
}: {
  form: LimitForm
  errors: Partial<Record<LimitKey, string>>
  onChange: (key: LimitKey, value: string) => void
  placeholder?: string
}) {
  return (
    <>
      {LIMIT_FIELDS.map(([key, label, min, max, step]) => (
        <label key={key} className="flex flex-col gap-1">
          <span className="label">{label}</span>
          <input
            type="number"
            inputMode="decimal"
            min={min}
            max={max}
            step={step}
            placeholder={placeholder}
            value={form[key]}
            aria-invalid={!!errors[key]}
            onChange={(e) => onChange(key, e.target.value)}
            className="w-full"
          />
          {errors[key] && (
            <span role="alert" className="text-xs text-red-text">
              {errors[key]}
            </span>
          )}
        </label>
      ))}
    </>
  )
}
