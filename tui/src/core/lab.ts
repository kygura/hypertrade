// Remote Lab pulse for the TUI's /pulse command and the agent's lab_pulse tool.
// Mirrors scripts/lab-cli.ts remote() and src/ui/lib/lab.ts labCall(): POST
// <LAB_URL>/api/lab/tools/lab_market_pulse with a bearer token and an
// {ok, result} envelope. The token is never included in any error message.
import { z } from "zod";

export const PulseRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  direction: z.enum(["long", "short"]),
  firing: z.boolean(),
  text: z.string(),
});

export const PulseAssetSchema = z.object({
  asset: z.string(),
  longActive: z.number().int().nonnegative(),
  longTotal: z.number().int().nonnegative(),
  shortActive: z.number().int().nonnegative(),
  shortTotal: z.number().int().nonnegative(),
  /** (longActive − shortActive) / (longTotal + shortTotal), in −1..1. */
  lean: z.number().min(-1).max(1),
  rules: z.array(PulseRuleSchema),
});

export const PulseSchema = z.object({
  asOf: z.string(),
  assets: z.array(PulseAssetSchema),
  warnings: z.array(z.string()),
});

export type PulseRule = z.infer<typeof PulseRuleSchema>;
export type PulseAsset = z.infer<typeof PulseAssetSchema>;
export type Pulse = z.infer<typeof PulseSchema>;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface Envelope {
  ok?: boolean;
  result?: unknown;
  error?: unknown;
}

function parseEnvelope(text: string): Envelope | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Envelope) : null;
  } catch {
    return null;
  }
}

export async function fetchPulse(lab: { url: string; token: string }, fetchFn: FetchFn = fetch): Promise<Pulse> {
  const base = lab.url.replace(/\/+$/, "");
  const res = await fetchFn(`${base}/api/lab/tools/lab_market_pulse`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${lab.token}`,
      "content-type": "application/json",
      "x-lab-source": "tui",
      accept: "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error("unauthorized: check LAB_API_TOKEN");
  const text = await res.text();
  const body = parseEnvelope(text);
  if (!res.ok || body?.ok === false) {
    const reason = typeof body?.error === "string" ? body.error : res.statusText || "request failed";
    throw new Error(`lab_market_pulse failed: ${reason} [HTTP ${res.status}]`);
  }
  const parsed = PulseSchema.safeParse(body?.result);
  if (!parsed.success) throw new Error(`lab_market_pulse: unexpected response shape (${parsed.error.issues[0]?.path.join(".") ?? "root"})`);
  return parsed.data;
}
