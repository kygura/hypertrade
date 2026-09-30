import { DEFAULT_MODEL, anthropicCredentials, openaiCredentials, type AnalystEnv, type ProviderId } from "./provider.js";

// The analyst's model/provider catalog (GET /api/analyst/models). Lists
// what a client may pick for POST /api/analyst/query's optional
// provider/model/effort fields, and whether each provider is configured at
// all — 200 even when nothing is configured, so the UI can explain what to
// set (DESIGN.md state vocabulary §6, "unconfigured").
//
// Anthropic's catalog is a fixed, hand-maintained list (its capabilities —
// tier, "best for", effort support — are known ahead of time); the
// openai-compatible catalog is whatever the deployment names via
// ANALYST_MODELS/ANALYST_MODEL, since an arbitrary endpoint's model list and
// capabilities are not knowable here.

export type Tier = "frontier" | "balanced" | "fast";

export interface CatalogModel {
  id: string;
  label: string;
  /** One-line "best for" note. */
  note: string;
  tier: Tier;
  /** Whether this model accepts the query's optional `effort` field. */
  effort: boolean;
}

export interface ProviderCatalogEntry {
  id: ProviderId;
  label: string;
  available: boolean;
  /** Present only when unavailable — what env var(s) to set. */
  reason?: string;
  models: CatalogModel[];
}

export interface AnalystCatalog {
  default: { provider: ProviderId; model: string };
  providers: ProviderCatalogEntry[];
}

/**
 * The selectable Anthropic Claude 5 family. Confirmed against the
 * claude-api skill's current model table (exact ids — no date suffixes).
 * `effort` mirrors the skill's per-model effort support: Fable 5.1, Opus
 * 5.5 and Sonnet 5 all take `low`..`max`; Haiku 4.5 does not (it still
 * takes only the legacy `budget_tokens` thinking knob, which this app does
 * not expose). Update this list when Anthropic ships a new model in the
 * family — re-run the claude-api skill to confirm ids first.
 */
export const ANTHROPIC_MODELS: CatalogModel[] = [
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    note: "Most capable — hardest reasoning, long multi-tool digs",
    tier: "frontier",
    effort: true,
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    note: "Deep multi-step market reads, cheaper than Fable",
    tier: "frontier",
    effort: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    note: "Balanced daily driver for most analyst questions",
    tier: "balanced",
    effort: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    note: "Fast, cheap answers for quick lookups",
    tier: "fast",
    effort: false,
  },
];

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI-compatible",
};

function rawProviderKind(env: AnalystEnv): ProviderId | "unknown" {
  const kind = (env.ANALYST_PROVIDER ?? "anthropic").trim().toLowerCase() || "anthropic";
  if (kind === "anthropic") return "anthropic";
  if (kind === "openai-compatible" || kind === "openai") return "openai-compatible";
  return "unknown";
}

/** Which provider ANALYST_PROVIDER/ANALYST_MODEL settings apply to (`default`).
 * An unrecognised ANALYST_PROVIDER falls back to "anthropic" here — purely
 * for labelling `default.provider`; it does not grant anthropic the legacy
 * ANALYST_API_KEY fallback (see anthropicCredentials/rawProviderKind). */
function catalogDefaultProvider(env: AnalystEnv): ProviderId {
  return rawProviderKind(env) === "openai-compatible" ? "openai-compatible" : "anthropic";
}

/**
 * Parses ANALYST_MODELS ("id,id2=Label Two,id3") into catalog entries. When
 * unset, falls back to a single entry from ANALYST_MODEL, but only when
 * openai-compatible is the default provider (ANALYST_MODEL otherwise
 * belongs to the default provider's own settings — see README/.env.example
 * precedence notes).
 */
export function parseOpenAIModels(env: AnalystEnv): CatalogModel[] {
  const toModel = (id: string, label: string): CatalogModel => ({
    id,
    label,
    note: "From ANALYST_MODELS/ANALYST_MODEL — capabilities unknown for this endpoint",
    tier: "balanced",
    effort: false,
  });
  const raw = env.ANALYST_MODELS?.trim();
  if (raw) {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const eq = entry.indexOf("=");
        const id = (eq >= 0 ? entry.slice(0, eq) : entry).trim();
        const label = (eq >= 0 ? entry.slice(eq + 1) : entry).trim() || id;
        return toModel(id, label);
      })
      .filter((m) => m.id.length > 0);
  }
  if (catalogDefaultProvider(env) === "openai-compatible") {
    const model = env.ANALYST_MODEL?.trim();
    if (model) return [toModel(model, model)];
  }
  return [];
}

function anthropicReason(apiKey: string | undefined): string | undefined {
  return apiKey ? undefined : "set ANALYST_ANTHROPIC_API_KEY";
}

function openaiReason(apiKey: string | undefined, baseURL: string | undefined): string | undefined {
  if (!apiKey && !baseURL) return "set ANALYST_OPENAI_API_KEY and ANALYST_OPENAI_BASE_URL";
  if (!apiKey) return "set ANALYST_OPENAI_API_KEY";
  if (!baseURL) return "set ANALYST_OPENAI_BASE_URL";
  return undefined;
}

/** Builds the full catalog for GET /api/analyst/models. Always 200-able:
 * every field resolves even when nothing is configured. */
export function buildCatalog(env: AnalystEnv): AnalystCatalog {
  const anthropic = anthropicCredentials(env);
  const openai = openaiCredentials(env);
  const openaiModels = parseOpenAIModels(env);

  const providers: ProviderCatalogEntry[] = [
    {
      id: "anthropic",
      label: PROVIDER_LABEL.anthropic,
      available: !!anthropic.apiKey,
      reason: anthropicReason(anthropic.apiKey),
      models: ANTHROPIC_MODELS,
    },
    {
      id: "openai-compatible",
      label: PROVIDER_LABEL["openai-compatible"],
      available: !!openai.apiKey && !!openai.baseURL,
      reason: openaiReason(openai.apiKey, openai.baseURL),
      models: openaiModels,
    },
  ];

  const defaultProvider = catalogDefaultProvider(env);
  const defaultModel =
    defaultProvider === "anthropic" ? env.ANALYST_MODEL?.trim() || DEFAULT_MODEL : env.ANALYST_MODEL?.trim() || openaiModels[0]?.id || "";

  return { default: { provider: defaultProvider, model: defaultModel }, providers };
}
