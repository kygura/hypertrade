import type { AddressSighting, PlatformStore } from "./store.js";

// Trade addresses arrive at thousands per minute; the store takes them in one
// batch every 5 s (SPEC P0.4). One entry per address keeps the latest sighting.
// ponytail: the store's address book has no notional column, so px×sz is not
// kept here; add it to AddressSighting when the crawler priority wants it.

export const FLUSH_MS = 5_000;

export interface AddressBuffer {
  add(addresses: readonly string[], seenAtMs: number): void;
  /** Writes the buffer in one batch; a failed write keeps the rows for the next flush. */
  flush(): Promise<number>;
  stop(): Promise<void>;
  readonly size: number;
}

export function createAddressBuffer(
  store: Pick<PlatformStore, "recordAddresses">,
  { flushMs = FLUSH_MS, log = console.error }: { flushMs?: number; log?: (...a: unknown[]) => void } = {},
): AddressBuffer {
  let buf = new Map<string, number>();
  let running: Promise<number> | null = null;
  const run = async () => {
    if (!buf.size) return 0;
    const taken = buf;
    buf = new Map();
    try {
      const rows: AddressSighting[] = [];
      for (const [address, ms] of taken) {
        try {
          rows.push({ address, seenAt: new Date(ms).toISOString() });
        } catch {
          taken.delete(address); // a bad trade time drops that address only
        }
      }
      return await store.recordAddresses(rows);
    } catch (err) {
      log("[addresses] flush failed:", err instanceof Error ? err.message : err);
      for (const [a, ms] of taken) if ((buf.get(a) ?? 0) < ms) buf.set(a, ms); // ponytail: unbounded only while the store is down
      return 0;
    }
  };
  /** One flush at a time: a slow store must not stack overlapping batches. */
  const flush = () => (running ??= run().finally(() => void (running = null)));
  const timer = setInterval(() => void flush(), flushMs);
  timer.unref?.();
  return {
    add(addresses, seenAtMs) {
      for (const a of addresses) if ((buf.get(a) ?? 0) < seenAtMs) buf.set(a, seenAtMs);
    },
    flush,
    async stop() {
      clearInterval(timer);
      await running;
      await flush();
    },
    get size() {
      return buf.size;
    },
  };
}
