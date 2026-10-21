// bun run signals:collect [--prev <file>] [--out <file>]   one JSON snapshot (stdout, or --out via temp file + rename)
// bun run signals:notify "<title>" "<body>"  one ntfy push via the desk notifier (NTFY_TOPIC, NTFY_SERVER, NTFY_TOKEN)
// Reads the deployed app only (APP_URL + LAB_API_TOKEN bearer, GETs), the Lab trial log included: the routine's
// cloud session has no route to Postgres, so nothing here opens a database connection.
import { readFile, rename, writeFile } from "node:fs/promises";
import { createNotifier } from "../src/server/desk/notify.js";
import { collectSignals, type Signals, type SignalsRaw } from "../src/server/routine/signals.js";
import { myMarkets } from "../src/server/platform/universe.js";

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "notify") {
  const [title, body] = args;
  const n = createNotifier();
  if (!title || !body || !n.channels.includes("ntfy")) {
    console.error('usage: signals:notify "<title>" "<body>" (NTFY_TOPIC must be set)');
    process.exit(2);
  }
  const sent = await n.send({ level: "info", title, body });
  console.log(`sent via ${sent.join(",") || "nothing"}`);
  if (!sent.length) process.exit(1);
} else if (cmd === "collect") {
  const base = process.env.APP_URL?.replace(/\/+$/, "");
  if (!base) throw new Error("APP_URL not set");
  const headers = { accept: "application/json", ...(process.env.LAB_API_TOKEN ? { authorization: `Bearer ${process.env.LAB_API_TOKEN}` } : {}) };
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${base}/api${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return (await r.json()) as T;
  };
  const flagVal = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const prevPath = flagVal("--prev");
  const outPath = flagVal("--out");

  const snapshot = await collectSignals(
    {
      prev: async () => (prevPath ? (JSON.parse(await readFile(prevPath, "utf8")) as Signals) : null),
      nearMisses: async () => (await get<{ all: NonNullable<SignalsRaw["nearMisses"]> }>("/platform/near-miss")).all,
      novelty: async () => (await get<{ entries: NonNullable<SignalsRaw["novelty"]> }>("/platform/novelty?days=7")).entries,
      ready: async () => {
        const rows = (await get<{ opportunities: NonNullable<SignalsRaw["ready"]>[number]["row"][] }>("/platform/opportunities?status=ready&limit=20")).opportunities;
        return Promise.all(rows.map(async (row) => ({ row, evidence: (await get<{ evidence: string }>(`/platform/opportunities/${row.id}`)).evidence })));
      },
      theses: async () => (await get<{ theses: NonNullable<SignalsRaw["theses"]> }>("/intel/theses")).theses,
      trials: async () => (await get<{ trials: NonNullable<SignalsRaw["trials"]> }>("/lab/trials?limit=50")).trials,
      myMarkets: myMarkets(),
    },
    new Date(),
  );
  const text = JSON.stringify(snapshot, null, 2);
  if (outPath) {
    await writeFile(`${outPath}.tmp`, text);
    await rename(`${outPath}.tmp`, outPath);
  } else console.log(text);
  process.exit(0);
} else {
  console.error("usage: signals.ts collect [--prev <file>] | notify <title> <body>");
  process.exit(2);
}
