import type { ParamSpec } from '../../../shared/strategy-protocol'
import { coerceParam, paramLabel, type ParamErrors, type ParamValues } from '../../../shared/strategy-params'
import { Segmented } from '../Segmented'

const BOOL_OPTIONS = [
  { value: true, label: 'TRUE' },
  { value: false, label: 'FALSE' },
]

// ParamForm — generated from manifest.params. number → <input type=number>
// with min/max/step; enum → <select>; bool → two ghost chips (TRUE/FALSE,
// selected-style — a native checkbox at 13px mono is too small a target on
// touch); string → <input>. Validation messages come from the caller
// (validateParams in src/shared/strategy-params.ts) keyed by param key, and
// render under the field in red-text. Every input has a visible .label.

export function ParamForm({
  specs,
  values,
  errors,
  onChange,
  disabled = false,
}: {
  specs: ParamSpec[]
  values: ParamValues
  errors: ParamErrors
  onChange: (key: string, value: unknown) => void
  disabled?: boolean
}) {
  if (specs.length === 0) {
    return <span className="text-[11px] uppercase tracking-wider text-text-secondary">no parameters</span>
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {specs.map((spec) => {
        const v = values[spec.key]
        const err = errors[spec.key]
        const id = `param-${spec.key}`
        return (
          <div key={spec.key} className="flex flex-col gap-1 min-w-0">
            <label htmlFor={id} className="label">
              {paramLabel(spec)}
            </label>
            {spec.type === 'number' && (
              <input
                id={id}
                type="number"
                inputMode="decimal"
                className="w-full"
                min={spec.min}
                max={spec.max}
                step={spec.step ?? 'any'}
                value={typeof v === 'number' && !Number.isNaN(v) ? v : ''}
                disabled={disabled}
                aria-invalid={!!err}
                onChange={(e) => onChange(spec.key, coerceParam(spec, e.target.value))}
              />
            )}
            {spec.type === 'string' && (
              <input
                id={id}
                className="w-full"
                value={typeof v === 'string' ? v : ''}
                disabled={disabled}
                aria-invalid={!!err}
                onChange={(e) => onChange(spec.key, coerceParam(spec, e.target.value))}
              />
            )}
            {spec.type === 'enum' && (
              <select
                id={id}
                className="w-full"
                value={typeof v === 'string' ? v : ''}
                disabled={disabled}
                aria-invalid={!!err}
                onChange={(e) => onChange(spec.key, coerceParam(spec, e.target.value))}
              >
                {(spec.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            )}
            {spec.type === 'bool' && (
              <Segmented
                id={id}
                label={paramLabel(spec)}
                size="md"
                options={BOOL_OPTIONS}
                value={v as boolean}
                disabled={disabled}
                onChange={(opt) => onChange(spec.key, opt)}
                className="self-start"
              />
            )}
            {spec.description && <span className="text-[10px] text-text-secondary">{spec.description}</span>}
            {(spec.min != null || spec.max != null || spec.step != null) && (
              <span className="text-[10px] text-text-secondary tabular">
                {spec.min != null && `min ${spec.min}`}
                {spec.max != null && ` · max ${spec.max}`}
                {spec.step != null && ` · step ${spec.step}`}
              </span>
            )}
            {err && (
              <span role="alert" className="text-[10px] text-red-text">
                {err}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
