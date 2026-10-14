import { ClaimSchema, type Claim } from "../../shared/claims.js";

// Claim validator (SPEC.md § Intel I0.7). Pure. Lines that are neither a
// sourced, timestamped `observed` fact nor a `hypothesis` are dropped before
// display; the caller records `dropped` in the trace.

export function validateClaims(raw: unknown[]): { claims: Claim[]; dropped: number } {
  const claims: Claim[] = [];
  for (const r of raw) {
    const parsed = ClaimSchema.safeParse(r);
    if (parsed.success) claims.push(parsed.data);
  }
  return { claims, dropped: raw.length - claims.length };
}

const text = { type: "string", minLength: 1, maxLength: 600 };

/** JSON schema for an array of claims (an `emit` tool property); mirrors ClaimSchema. */
export const claimsJsonSchema = {
  type: "array",
  items: {
    anyOf: [
      {
        type: "object",
        properties: {
          tag: { type: "string", enum: ["observed"] },
          text,
          source: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1, maxLength: 120 },
              url: { type: "string", maxLength: 2000 },
            },
            required: ["label"],
            additionalProperties: false,
          },
          ts: { type: "string", format: "date-time", description: "ISO 8601 with offset, e.g. 2026-10-13T14:00:00Z" },
        },
        required: ["tag", "text", "source", "ts"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { tag: { type: "string", enum: ["hypothesis"] }, text },
        required: ["tag", "text"],
        additionalProperties: false,
      },
    ],
  },
} as const;
