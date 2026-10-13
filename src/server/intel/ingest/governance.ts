import { z } from "zod";
import { AssetSchema } from "../../../shared/intel.js";
import type { NewEvent } from "../store.js";
import { fetchText, message, pastIso, type AdapterResult, type IngestDeps } from "./common.js";

// Snapshot governance (SPEC.md § Intel I0.10, I0.13): recent proposals for the
// spaces mapped from assets, as events; each proposal's vote end is its
// scheduled_at, so open votes surface as catalysts. Keyless hub GraphQL.

export const SNAPSHOT_HUB = "https://hub.snapshot.org/graphql";
/** Proposals created within this window are fetched. */
export const PROPOSAL_LOOKBACK_DAYS = 14;

/** asset → Snapshot space id. Check space ids when adding; INTEL_SNAPSHOT_SPACES ("AAVE=aave.eth,UNI=…") replaces the map. */
export const DEFAULT_SNAPSHOT_SPACES: Record<string, string> = {
  AAVE: "aave.eth",
  UNI: "uniswapgovernance.eth",
  ARB: "arbitrumfoundation.eth",
  OP: "opcollective.eth",
  LDO: "lido-snapshot.eth",
  ENS: "ens.eth",
  CRV: "curve.eth",
  GMX: "gmx.eth",
  BAL: "balancer.eth",
  CVX: "cvx.eth",
  SAFE: "safe.eth",
};

const SPACE_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/i;

export function snapshotSpaces(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env.INTEL_SNAPSHOT_SPACES?.trim();
  if (!raw) return DEFAULT_SNAPSHOT_SPACES;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [asset, space] = pair.split("=").map((s) => s?.trim() ?? "");
    if (asset && space && AssetSchema.safeParse(asset).success && SPACE_ID.test(space)) out[asset] = space;
  }
  return out;
}

const ProposalsSchema = z.object({
  data: z.object({
    proposals: z.array(
      z.object({
        id: z.string().min(1).max(200),
        title: z.string(),
        created: z.number(),
        end: z.number(),
        state: z.string().nullable().optional(),
        link: z.string().nullable().optional(),
        space: z.object({ id: z.string(), name: z.string().nullable().optional() }),
      }),
    ),
  }),
});

export const PROPOSALS_QUERY = `query Proposals($spaces: [String], $since: Int) {
  proposals(first: 100, skip: 0, where: {space_in: $spaces, created_gte: $since}, orderBy: "created", orderDirection: desc) {
    id title created end state link space { id name }
  }
}`;

/** Pure: hub response → events. Proposals from spaces outside the map are ignored. */
export function parseSnapshotProposals(json: unknown, spaces: Record<string, string>, now: Date): NewEvent[] {
  const assetBySpace = new Map(Object.entries(spaces).map(([asset, space]) => [space.toLowerCase(), asset]));
  const out: NewEvent[] = [];
  for (const p of ProposalsSchema.parse(json).data.proposals) {
    const asset = assetBySpace.get(p.space.id.toLowerCase());
    const title = p.title.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!asset || !title) continue;
    const name = (p.space.name?.trim() || p.space.id).slice(0, 64);
    const url = p.link && /^https:\/\//.test(p.link) ? p.link : `https://snapshot.org/#/${p.space.id}/proposal/${encodeURIComponent(p.id)}`;
    out.push({
      key: `snapshot:${p.id}`,
      type: "governance",
      title: `${name}: ${title}`,
      summary: p.state ? `Snapshot vote, ${p.state}.` : null,
      entities: [...new Set([name, asset])],
      assets: [asset],
      magnitude: "low",
      sources: [{ label: `Snapshot ${p.space.id}`.slice(0, 120), url }],
      origin: "governance",
      firstSeen: pastIso(new Date(p.created * 1000).toISOString(), now)!,
      scheduledAt: new Date(p.end * 1000).toISOString(),
      catalyst: null,
      tag: "observed",
    });
  }
  return out;
}

export async function fetchGovernance(deps: Pick<IngestDeps, "fetch" | "env" | "now" | "signal">): Promise<AdapterResult> {
  const spaces = snapshotSpaces(deps.env);
  const ids = [...new Set(Object.values(spaces))];
  if (!ids.length) return { source: "governance", ok: true, items: [], error: "skipped:no-spaces" };
  const now = deps.now();
  const since = Math.floor(now.getTime() / 1000) - PROPOSAL_LOOKBACK_DAYS * 86_400;
  try {
    const body = await fetchText(
      deps.fetch,
      SNAPSHOT_HUB,
      { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query: PROPOSALS_QUERY, variables: { spaces: ids, since } }) },
      deps.signal,
    );
    return { source: "governance", ok: true, items: parseSnapshotProposals(JSON.parse(body), spaces, now) };
  } catch (e) {
    return { source: "governance", ok: false, items: [], error: message(e).slice(0, 500) };
  }
}
