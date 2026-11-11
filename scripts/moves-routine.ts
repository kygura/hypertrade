// The scheduled routine's moves investigations (ROUTINE.md § Moves), over HTTPS only (APP_URL + LAB_API_TOKEN):
//   bun run moves:triage                    today's open triage items without a record, each with its code-computed facts
//   bun run moves:propose <coin> <file.json> posts one proposal (AgentProposalSchema); prints the stored record or the
//                                            server's refusal. Code stamps, vets, stores and later grades the record.
// No database connection, no order, approve or desk path: the server's POST /moves/:coin/proposal is the one write.
import { readFile } from "node:fs/promises";
import { MoveDetailSchema, type MoveDetail } from "../src/shared/moves.js";
import { TriageResponseSchema } from "../src/shared/agentRecords.js";
import { detailRequest, formatProposalReply, formatTriage, needsProposal, parseProposal, proposalRequest, routineConfig, triageRequest } from "../src/server/moves/routineCli.js";

const [cmd, ...args] = process.argv.slice(2);
const TIMEOUT_MS = 60_000;

async function call({ url, init }: { url: string; init: RequestInit }): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text.slice(0, 300) };
  }
}

async function main(): Promise<number> {
  if (cmd !== "triage" && cmd !== "propose") {
    console.error("usage: moves-routine.ts triage | propose <coin> <file.json>");
    return 2;
  }
  if (cmd === "propose") {
    const [coin, file] = args;
    if (!coin || !file) {
      console.error("usage: bun run moves:propose <coin> <file.json>");
      return 2;
    }
    const parsed = parseProposal(await readFile(file, "utf8"));
    if (!parsed.ok) {
      console.error(parsed.error);
      return 2;
    }
    const cfg = routineConfig(process.env);
    const r = await call(proposalRequest(cfg, coin, parsed.proposal));
    const out = formatProposalReply(r.status, r.body);
    (out.code ? console.error : console.log)(out.text);
    return out.code;
  }
  const cfg = routineConfig(process.env);
  const t = await call(triageRequest(cfg));
  if (t.status !== 200) {
    console.error(`triage: HTTP ${t.status} ${JSON.stringify(t.body).slice(0, 300)}`);
    return 1;
  }
  const triage = TriageResponseSchema.parse(t.body);
  const details = new Map<string, { detail: MoveDetail | null; error?: string }>();
  for (const item of needsProposal(triage)) {
    const d = await call(detailRequest(cfg, item.coin)).catch((e: unknown) => ({ status: 0, body: e instanceof Error ? e.message : String(e) }));
    const p = d.status === 200 ? MoveDetailSchema.safeParse(d.body) : null;
    details.set(item.coin, p?.success ? { detail: p.data } : { detail: null, error: `HTTP ${d.status} ${JSON.stringify(d.body).slice(0, 200)}` });
  }
  console.log(formatTriage(triage, details));
  return 0;
}

process.exit(await main().catch((e: unknown) => (console.error(e instanceof Error ? e.message : String(e)), 1)));
