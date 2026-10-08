// A minimal Postgres wire-protocol server for tests: it completes the startup
// handshake, then answers every query with zero rows ("answer") or swallows
// it and never replies ("silent"), the way a dead pooler socket behaves.
import net from "node:net";

const msg = (type: string, body: Buffer = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const READY = msg("Z", Buffer.from("I"));
const STARTED = Buffer.concat([msg("R", int32(0)), READY]);
const int16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
/** ParameterDescription: every $n of the parsed query typed as text (oid 25). */
const paramDescription = (query: string) => {
  const n = Math.max(0, ...[...query.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  return msg("t", Buffer.concat([int16(n), ...Array.from({ length: n }, () => int32(25))]));
};

export type FakePg = {
  url: string;
  mode: "answer" | "silent";
  /** Connections accepted so far. */
  connections: number;
  /** Syncs received (a query is one or two: describe, then execute). */
  queries: number;
  close(): Promise<void>;
};

export async function startFakePg(): Promise<FakePg> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    fake.connections++;
    let buf = Buffer.alloc(0);
    let started = false;
    let query = "";
    let reply: Buffer[] = [];
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
          buf = buf.subarray(buf.readInt32BE(0));
          started = true;
          socket.write(STARTED);
          continue;
        }
        if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
        const type = String.fromCharCode(buf[0]!);
        const body = buf.subarray(5, 1 + buf.readInt32BE(1));
        buf = buf.subarray(1 + buf.readInt32BE(1));
        // Each extended-protocol message gets its reply; Flush and Sync send them.
        if (type === "X") return void socket.end();
        if (type === "P") (query = body.toString("latin1").split("\0")[1] ?? ""), reply.push(msg("1"));
        else if (type === "B") reply.push(msg("2"));
        else if (type === "D") reply.push(...(body[0] === 83 ? [paramDescription(query), msg("n")] : [msg("n")]));
        else if (type === "E") reply.push(msg("C", Buffer.from("SELECT 0\0")));
        else if (type === "H") {
          if (fake.mode === "answer") socket.write(Buffer.concat(reply));
          reply = [];
        } else if (type === "S") {
          fake.queries++;
          if (fake.mode === "answer") socket.write(Buffer.concat([...reply, READY]));
          reply = [];
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  const fake: FakePg = {
    url: `postgres://u:p@127.0.0.1:${port}/db`,
    mode: "answer",
    connections: 0,
    queries: 0,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
  return fake;
}
