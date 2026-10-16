import { describe, expect, test } from "bun:test";
import { createAddressBuffer } from "./addresses";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);

describe("address buffer", () => {
  test("batches and dedupes to one write, keeping the latest sighting", async () => {
    const calls: { address: string; seenAt: string }[][] = [];
    const buf = createAddressBuffer({ recordAddresses: async (r) => (calls.push(r), r.length) }, { flushMs: 20 });
    buf.add([A, B], 1_000);
    buf.add([A], 3_000);
    buf.add([A], 2_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(1);
    expect(calls[0]!.find((r) => r.address === A)!.seenAt).toBe(new Date(3_000).toISOString());
    expect(calls[0]!.length).toBe(2);
    expect(buf.size).toBe(0);
    await buf.stop();
  });

  test("a failed write is retried on the next flush", async () => {
    let fail = true;
    const calls: number[] = [];
    const buf = createAddressBuffer(
      { recordAddresses: async (r) => { if (fail) throw new Error("db down"); calls.push(r.length); return r.length; } },
      { flushMs: 60_000, log: () => {} },
    );
    buf.add([A], 1);
    expect(await buf.flush()).toBe(0);
    expect(buf.size).toBe(1);
    fail = false;
    expect(await buf.flush()).toBe(1);
    expect(calls).toEqual([1]);
    await buf.stop();
  });
});
