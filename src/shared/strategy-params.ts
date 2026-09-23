// Client-side validation of StrategyConfig.params against a Manifest's
// ParamSpec list. Mirrors what the core enforces on PUT (400 with
// {error, field}) so the form can refuse before the round trip. Pure — no
// React — so `bun test src` covers it.
import type { ParamSpec } from "./strategy-protocol";

export type ParamValues = Record<string, unknown>;
export type ParamErrors = Record<string, string>;

const EPS = 1e-9;

export function paramLabel(spec: ParamSpec): string {
  return spec.label ?? spec.key;
}

/** Default values for every spec, used to seed a form for a fresh config. */
export function defaultParams(specs: ParamSpec[]): ParamValues {
  const out: ParamValues = {};
  for (const s of specs) {
    if (s.default !== undefined) out[s.key] = s.default;
    else if (s.type === "number") out[s.key] = s.min ?? 0;
    else if (s.type === "bool") out[s.key] = false;
    else if (s.type === "enum") out[s.key] = s.options?.[0] ?? "";
    else out[s.key] = "";
  }
  return out;
}

/** Coerce a raw input string into the spec's runtime type. */
export function coerceParam(spec: ParamSpec, raw: string | boolean): unknown {
  if (spec.type === "bool") return typeof raw === "boolean" ? raw : raw === "true";
  if (spec.type === "number") {
    if (typeof raw === "boolean") return Number.NaN;
    if (raw.trim() === "") return Number.NaN;
    return Number(raw);
  }
  return String(raw);
}

/** One message per failing key; empty object when everything passes. */
export function validateParams(specs: ParamSpec[], values: ParamValues): ParamErrors {
  const errors: ParamErrors = {};
  for (const spec of specs) {
    const v = values[spec.key];
    const msg = validateParam(spec, v);
    if (msg) errors[spec.key] = msg;
  }
  return errors;
}

export function validateParam(spec: ParamSpec, v: unknown): string | null {
  switch (spec.type) {
    case "number": {
      if (typeof v !== "number" || Number.isNaN(v)) return "must be a number";
      if (spec.min != null && v < spec.min - EPS) return `must be ≥ ${spec.min}`;
      if (spec.max != null && v > spec.max + EPS) return `must be ≤ ${spec.max}`;
      if (spec.step != null && spec.step > 0) {
        const origin = spec.min ?? 0;
        const q = (v - origin) / spec.step;
        if (Math.abs(q - Math.round(q)) > 1e-6) return `must be a multiple of ${spec.step}`;
      }
      return null;
    }
    case "bool":
      return typeof v === "boolean" ? null : "must be true or false";
    case "enum": {
      const opts = spec.options ?? [];
      if (typeof v !== "string" || !opts.includes(v)) return `must be one of ${opts.join(", ")}`;
      return null;
    }
    case "string":
      return typeof v === "string" ? null : "must be text";
  }
}
