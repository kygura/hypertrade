import { z } from "zod";

// Claim tagging (docs/SPEC.md § Intel I0.7). Every LLM output line shown by Intel
// is either an observed fact with a source and a timestamp, or a hypothesis
// marked as inference. The server validator (src/server/intel/claims.ts)
// drops anything else before display.

export const ObservedClaimSchema = z
  .object({
    tag: z.literal("observed"),
    text: z.string().trim().min(1).max(600),
    source: z
      .object({
        label: z.string().trim().min(1).max(120),
        url: z.string().trim().max(2000).optional(),
      })
      .strict(),
    ts: z.string().datetime({ offset: true }),
  })
  .strict();

export const HypothesisClaimSchema = z
  .object({
    tag: z.literal("hypothesis"),
    text: z.string().trim().min(1).max(600),
  })
  .strict();

export const ClaimSchema = z.discriminatedUnion("tag", [ObservedClaimSchema, HypothesisClaimSchema]);
export type Claim = z.infer<typeof ClaimSchema>;
export type ObservedClaim = z.infer<typeof ObservedClaimSchema>;
export type HypothesisClaim = z.infer<typeof HypothesisClaimSchema>;
