import { loadDeskConfig, type GovernorLimits } from "../../../src/server/desk/config.js";
import { addressOf, isPrivateKey } from "../../../src/server/desk/hl/signing.js";
import type { Config, GovernorEnvLimits, Network } from "./types.js";

// Start-up configuration (SPEC.md "Configuration"). Read once; pure.
//
// Safety rules:
// - Mainnet only when HT_NETWORK is exactly "mainnet" and not in --demo.
// - The agent key is validated, normalised and returned separately; it never
//   goes into Config, and no warning ever echoes it (or any env value: a key
//   pasted into the wrong variable must not end up on screen either).
// - A bad number falls back to its default with a warning, never to 0 or NaN.

type Env = Record<string, string | undefined>;

export interface LoadedConfig {
  config: Config;
  /** 0x-prefixed private key, or null (read-only). Hand it only to createExchange. */
  agentKey: string | null;
  warnings: string[];
}

/** Account the demo fixtures are read for (same placeholder as demo.ts; the demo source answers for any address). */
export const DEMO_ACCOUNT = "0xde30de30de30de30de30de30de30de30de30de30";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const COIN_RE = /^([A-Za-z0-9]+:)?[A-Za-z0-9]+$/;
const DEFAULT_WATCH = ["BTC", "ETH", "SOL", "HYPE"];

/** Desk governor defaults (minStopPct, dailyLossLimitPct, fees…), from the desk's own loader with an empty env. */
const DESK_LIMITS: GovernorLimits = loadDeskConfig({}).limits;

/** The TUI's six env limits merged onto the desk's full GovernorLimits. */
export function governorLimits(l: GovernorEnvLimits): GovernorLimits {
  return { ...DESK_LIMITS, ...l };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function num(env: Env, key: string, def: number, min: number, max: number, warnings: string[], integer = false): number {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    warnings.push(`${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}; using the default ${def}`);
    return def;
  }
  return n;
}

function watchList(raw: string | undefined, warnings: string[]): string[] {
  const tokens = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.length) return DEFAULT_WATCH;
  const out: string[] = [];
  let bad = 0;
  for (const t of tokens) {
    if (t.length > 24 || !COIN_RE.test(t)) {
      bad++;
      continue;
    }
    // "btc" → "BTC"; mixed case such as "kPEPE" is a real Hyperliquid name and is kept.
    const coin = t === t.toLowerCase() ? t.toUpperCase() : t;
    if (!out.includes(coin)) out.push(coin);
  }
  if (bad) warnings.push(`HT_WATCH: ${bad} invalid ${bad === 1 ? "entry" : "entries"} ignored`);
  return out.length ? out : DEFAULT_WATCH;
}

function lab(env: Env, warnings: string[]): Config["lab"] {
  const url = env.LAB_URL?.trim().replace(/\/+$/, "");
  const token = env.LAB_API_TOKEN?.trim();
  if (!url && !token) return null;
  if (!url || !token) {
    warnings.push(`${url ? "LAB_API_TOKEN" : "LAB_URL"} is not set: Lab pulse disabled`);
    return null;
  }
  if (!/^https?:\/\/[^\s/]+/.test(url)) {
    warnings.push("LAB_URL is not an http(s) URL: Lab pulse disabled");
    return null;
  }
  return { url, token };
}

export function loadConfig(env: Env, argv: string[]): LoadedConfig {
  const warnings: string[] = [];
  const demo = argv.includes("--demo");

  // Network: exact match only. Anything else is testnet, never mainnet.
  const rawNet = env.HT_NETWORK;
  let network: Network = "testnet";
  if (rawNet === "mainnet") network = "mainnet";
  else if (rawNet != null && rawNet !== "" && rawNet !== "testnet") warnings.push("HT_NETWORK must be exactly testnet or mainnet; using testnet");
  if (demo && network === "mainnet") {
    warnings.push("demo: HT_NETWORK=mainnet ignored; fixtures only");
    network = "testnet";
  }

  // Agent key: validated, never echoed. addressOf also rejects scalars that are not valid secp256k1 keys.
  let agentKey: string | null = null;
  let keyAddress: string | null = null;
  const rawKey = env.HT_AGENT_KEY?.trim();
  if (rawKey) {
    if (demo) {
      warnings.push("demo: HT_AGENT_KEY ignored; orders are disabled");
    } else if (!isPrivateKey(rawKey)) {
      warnings.push("HT_AGENT_KEY is not a valid private key (64 hex characters); running read-only");
    } else {
      const key = rawKey.startsWith("0x") || rawKey.startsWith("0X") ? `0x${rawKey.slice(2)}` : `0x${rawKey}`;
      try {
        keyAddress = addressOf(key).toLowerCase();
        agentKey = key;
      } catch {
        warnings.push("HT_AGENT_KEY is not a valid secp256k1 private key; running read-only");
      }
    }
  }

  // Account: HT_ACCOUNT, else the key's own address. Never echoed when invalid (it may be a misplaced key).
  const rawAcct = env.HT_ACCOUNT?.trim();
  let account: string | null = null;
  if (rawAcct) {
    if (ADDRESS_RE.test(rawAcct)) account = rawAcct.toLowerCase();
    else warnings.push("HT_ACCOUNT is not a 0x-prefixed 40-hex address; ignored");
  }
  if (demo) account = DEMO_ACCOUNT;
  else if (!account && keyAddress) {
    account = keyAddress;
    warnings.push(
      `HT_AGENT_KEY is set without HT_ACCOUNT: positions and equity are read from the key's own address ${short(keyAddress)}. ` +
        "For an API wallet that is the agent, not your master account: set HT_ACCOUNT to the master address.",
    );
  }

  if (agentKey && network === "mainnet") warnings.push("MAINNET with a trading key: orders use real funds");

  const limits: GovernorEnvLimits = {
    maxRiskPct: num(env, "HT_MAX_RISK_PCT", DESK_LIMITS.maxRiskPct, 0.05, 2, warnings),
    maxOpenRiskPct: num(env, "HT_MAX_OPEN_RISK_PCT", DESK_LIMITS.maxOpenRiskPct, 0.1, 10, warnings),
    maxGrossLeverage: num(env, "HT_MAX_GROSS_LEV", 5, 0.1, 10, warnings),
    maxCoinLeverage: num(env, "HT_MAX_COIN_LEV", 3, 0.05, 5, warnings),
    maxPositions: num(env, "HT_MAX_POSITIONS", DESK_LIMITS.maxPositions, 1, 20, warnings, true),
    minRewardRisk: num(env, "HT_MIN_RR", DESK_LIMITS.minRewardRisk, 0.5, 10, warnings),
  };

  const config: Config = {
    network,
    account,
    canTrade: agentKey != null,
    maxNotionalUsd: num(env, "HT_MAX_NOTIONAL_USD", 1000, 1, 10_000_000, warnings),
    slippage: num(env, "HT_SLIPPAGE_PCT", 1, 0.01, 5, warnings) / 100,
    watch: watchList(env.HT_WATCH, warnings),
    limits,
    defaultLeverage: 3,
    lab: lab(env, warnings),
    demo,
  };
  return { config, agentKey, warnings };
}
