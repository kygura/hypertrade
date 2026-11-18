// ULIDs for Propr's intentId and orderGroupId: the ladder's send time, then a hash of a seed (the proposal id, the
// rung and the order's role). One send per approval is the desk's job (the store claims a proposal before it is sent).
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

const isUlid = (s: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);

/** The desk's own ladder orders: the ladder's creation time, then the tag "PRD", then the rung, so housekeeping can
 * find every order of a ladder, its age and its rung from the intentId alone. perp-radar's executor tags its own
 * ladders "PRX"; the desk never touches those and refuses to trade while any are on the account. */
const LADDER_TAG = "PRD";
const PERP_RADAR_TAG = "PRX";
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
/** An order perp-radar's executor placed (its ladders carry "PRX" where the desk's carry "PRD"). */
export const isPerpRadarId = (id: unknown): id is string => typeof id === "string" && isUlid(id) && id.slice(10, 13) === PERP_RADAR_TAG;
