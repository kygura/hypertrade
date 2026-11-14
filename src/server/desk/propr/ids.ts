// ULIDs for Propr's intentId and orderGroupId, deterministic from a seed: the desk seeds them with the proposal id,
// so a retried send of the same proposal produces the same ids and Propr's idempotency (same intentId = same order)
// stops a double send.
import { createHash } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(timeMs: number, seed: string): string {
  let t = Math.max(0, Math.floor(timeMs));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = createHash("sha256").update(seed).digest();
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(bytes[i]!);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = ALPHABET[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}

export const isUlid = (s: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);

/** The desk's own ladder orders: the ladder's creation time, then the tag "PRX", then the rung, so housekeeping can
 * find every order of a ladder, its age and its rung from the intentId alone. Same tag as perp-radar's executor. */
export const LADDER_TAG = "PRX";
export function ladderId(ladderTimeMs: number, seed: string, rung: number, role: "entry" | "stop" | "tp" | "group" | "close"): string {
  const base = ulid(ladderTimeMs, `${seed}:${rung}:${role}`);
  return base.slice(0, 10) + LADDER_TAG + ALPHABET[rung % 32] + base.slice(14);
}

/** Milliseconds encoded in a ULID's first ten characters. */
export function ulidTime(id: string): number {
  let t = 0;
  for (const c of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(c);
  return t;
}

export const isLadderId = (id: unknown): id is string => typeof id === "string" && isUlid(id) && id.slice(10, 13) === LADDER_TAG;
