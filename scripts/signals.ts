// bun run signals:collect [--prev <file>]   one JSON snapshot on stdout (SIGNALS-ROUTINE.md)
// bun run signals:notify "<title>" "<body>"  one ntfy push via the desk notifier (NTFY_TOPIC, NTFY_SERVER, NTFY_TOKEN)
// Reads the deployed app (APP_URL + LAB_API_TOKEN bearer, GETs only) and, if DATABASE_URL is set, the Lab trial log.
import { readFile } from "node:fs/promises";
import { createNotifier } from "../src/server/desk/notify.js";
import { assemble, type Signals, type SignalsRaw } from "../src/server/routine/signals.js";
import { myMarkets } from "../src/server/platform/universe.js";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "notify") {
  const [title, body] = args;
  const n = createNotifier();
  if (!title || !body || !n.channels.includes("ntfy")) {
    console.error('usage: signals:notify "<title>" "<body>" (NTFY_TOPIC must be set)');
    process.exit(2);
  }
  console.log(`sent via ${(await n.send({ level: "info", title, body })).join(",") || "nothing"}`);
} else if (cmd === "collect") {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("APP_URL not set");
  const headers = { accept: "application/json", ...(process.env.LAB_API_TOKEN ? { authorization: `Bearer ${process.env.LAB_API_TOKEN}` } : {}) };
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${base}/api${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  };
  const prevPath = args[args.indexOf("--prev") + 1];
  const prev: Signals | null = args.includes("--prev") && prevPath ? JSON.parse(await readFile(prevPath, "utf8")) : null;

  const ready = (await get<{ opportunities: SignalsRaw["ready"][number]["row"][] }>("/platform/opportunities?status=ready&limit=20")).opportunities;
  let trials: SignalsRaw["trials"] = null;
  if (process.env.DATABASE_URL) {
    const { defaultStore } = await import("../src/server/lab/store.js");
    trials = (await defaultStore().listTrials()).slice(-50);
  }
  const raw: SignalsRaw = {
    nearMisses: (await get<{ all: SignalsRaw["nearMisses"] }>("/platform/near-miss")).all,
    novelty: (await get<{ entries: SignalsRaw["novelty"] }>("/platform/novelty?days=7")).entries,
    ready: await Promise.all(ready.map(async (row) => ({ row, evidence: (await get<{ evidence: string }>(`/platform/opportunities/${row.id}`)).evidence }))),
    theses: (await get<{ theses: SignalsRaw["theses"] }>("/intel/theses")).theses,
    trials,
    myMarkets: myMarkets(),
  };
  console.log(JSON.stringify(assemble(raw, prev, new Date()), null, 2));
  process.exit(0);
} else {
  console.error("usage: signals.ts collect [--prev <file>] | notify <title> <body>");
  process.exit(2);
}
