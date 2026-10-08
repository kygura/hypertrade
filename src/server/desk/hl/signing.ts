import { encode } from "@msgpack/msgpack";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// Hyperliquid L1 action signing, a port of hyperliquid-python-sdk
// utils/signing.py (action_hash, construct_phantom_agent, sign_l1_action).
// signing.test.ts pins it to that SDK's published test vectors.
//
//   hash  = keccak256(msgpack(action) ‖ nonce u64 BE ‖ vault flag[‖ vault] [‖ 0x00 ‖ expiresAfter u64 BE])
//   agent = { source: "a" mainnet | "b" testnet, connectionId: hash }
//   sig   = EIP-712 sign(Agent(string source, bytes32 connectionId)),
//           domain { name "Exchange", version "1", chainId 1337, verifyingContract 0x0 }
//
// Key order inside `action` matters: msgpack keeps insertion order and the
// exchange hashes the bytes it receives, so wire builders (wire.ts) must
// construct objects in the SDK's field order.

export interface Signature {
  r: string;
  s: string;
  v: number;
}

const enc = new TextEncoder();
const keccak = (b: Uint8Array) => keccak_256(b);

function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

export function actionHash(action: unknown, vaultAddress: string | null, nonce: number, expiresAfter: number | null = null): Uint8Array {
  // ignoreUndefined: optional fields must be absent, not nil, to match the SDK's dicts.
  const parts = [encode(action, { ignoreUndefined: true }), u64be(nonce)];
  if (vaultAddress == null) parts.push(new Uint8Array([0]));
  else parts.push(new Uint8Array([1]), hexToBytes(strip0x(vaultAddress).toLowerCase()));
  if (expiresAfter != null) parts.push(new Uint8Array([0]), u64be(expiresAfter));
  return keccak(concat(parts));
}

function pad32(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

const DOMAIN_TYPEHASH = keccak(enc.encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const AGENT_TYPEHASH = keccak(enc.encode("Agent(string source,bytes32 connectionId)"));
const DOMAIN_SEPARATOR = keccak(
  concat([DOMAIN_TYPEHASH, keccak(enc.encode("Exchange")), keccak(enc.encode("1")), pad32(new Uint8Array([0x05, 0x39])), new Uint8Array(32)]),
);

/** EIP-712 digest of the phantom agent for an action hash. */
export function agentDigest(connectionId: Uint8Array, isMainnet: boolean): Uint8Array {
  const struct = keccak(concat([AGENT_TYPEHASH, keccak(enc.encode(isMainnet ? "a" : "b")), connectionId]));
  return keccak(concat([new Uint8Array([0x19, 0x01]), DOMAIN_SEPARATOR, struct]));
}

export function signDigest(digest: Uint8Array, privateKey: string): Signature {
  const raw = secp256k1.sign(digest, hexToBytes(strip0x(privateKey)), { prehash: false, format: "recovered", lowS: true });
  const sig = secp256k1.Signature.fromBytes(raw, "recovered");
  return { r: `0x${sig.r.toString(16).padStart(64, "0")}`, s: `0x${sig.s.toString(16).padStart(64, "0")}`, v: 27 + (sig.recovery ?? 0) };
}

export function signL1Action(
  privateKey: string,
  action: unknown,
  vaultAddress: string | null,
  nonce: number,
  expiresAfter: number | null,
  isMainnet: boolean,
): Signature {
  return signDigest(agentDigest(actionHash(action, vaultAddress, nonce, expiresAfter), isMainnet), privateKey);
}

/** Ethereum address of a private key (lowercase, 0x-prefixed). */
export function addressOf(privateKey: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(strip0x(privateKey)), false);
  return `0x${bytesToHex(keccak(pub.slice(1)).slice(-20))}`;
}

export function isPrivateKey(v: string | undefined): v is string {
  return !!v && /^(0x)?[0-9a-fA-F]{64}$/.test(v.trim());
}
