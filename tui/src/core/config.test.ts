import { describe, expect, test } from "bun:test";
import { addressOf } from "../../../src/server/desk/hl/signing.js";
import { DEMO_ACCOUNT, governorLimits, loadConfig } from "./config.js";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const MASTER = "0x1111111111111111111111111111111111111111";

/** No 8-character window of `secret` appears anywhere in `text`. */
function leaks(text: string, secret: string): boolean {
  const s = secret.replace(/^0x/i, "").toLowerCase();
  const t = text.toLowerCase();
  for (let i = 0; i + 8 <= s.length; i++) if (t.includes(s.slice(i, i + 8))) return true;
  return false;
}

describe("loadConfig", () => {
  test("defaults: testnet, read-only, no account, desk limits with coin 3x / gross 5x", () => {
    const { config, agentKey, warnings } = loadConfig({}, []);
    expect(agentKey).toBeNull();
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      network: "testnet",
      account: null,
      canTrade: false,
      maxNotionalUsd: 1000,
      slippage: 0.01,
      watch: ["BTC", "ETH", "SOL", "HYPE"],
      limits: { maxRiskPct: 0.5, maxOpenRiskPct: 2, maxGrossLeverage: 5, maxCoinLeverage: 3, maxPositions: 4, minRewardRisk: 1.5 },
      defaultLeverage: 3,
      lab: null,
      demo: false,
    });
  });

  test("mainnet only for the exact string", () => {
    expect(loadConfig({ HT_NETWORK: "mainnet" }, []).config.network).toBe("mainnet");
    for (const v of ["Mainnet", "MAINNET", " mainnet", "main", "prod"]) {
      const r = loadConfig({ HT_NETWORK: v }, []);
      expect(r.config.network).toBe("testnet");
      expect(r.warnings.join(" ")).toContain("HT_NETWORK");
    }
    expect(loadConfig({ HT_NETWORK: "testnet" }, []).warnings).toEqual([]);
  });

  test("--demo forces testnet, no key, no trading, demo account", () => {
    const r = loadConfig({ HT_NETWORK: "mainnet", HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER }, ["bun", "main.tsx", "--demo"]);
    expect(r.config).toMatchObject({ demo: true, network: "testnet", canTrade: false, account: DEMO_ACCOUNT });
    expect(r.agentKey).toBeNull();
    expect(leaks(r.warnings.join("\n"), KEY)).toBe(false);
  });

  test("a valid key enables trading; without HT_ACCOUNT the key's own address is read, with a warning", () => {
    const r = loadConfig({ HT_AGENT_KEY: KEY.slice(2) }, []);
    expect(r.agentKey).toBe(KEY);
    expect(r.config.canTrade).toBe(true);
    expect(r.config.account).toBe(addressOf(KEY));
    expect(r.warnings.join(" ")).toContain("without HT_ACCOUNT");
    expect(leaks(JSON.stringify(r.config) + r.warnings.join("\n"), KEY)).toBe(false);

    const m = loadConfig({ HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER.toUpperCase().replace("0X", "0x") }, []);
    expect(m.config.account).toBe(MASTER);
    expect(m.warnings).toEqual([]);
  });

  test("an invalid key is dropped with a warning that never echoes it", () => {
    for (const bad of [KEY.slice(0, -1), `${KEY}ff`, "0xnothex0123456789012345678901234567890123456789012345678901234", `0x${"0".repeat(64)}`]) {
      const r = loadConfig({ HT_AGENT_KEY: bad }, []);
      expect(r.agentKey).toBeNull();
      expect(r.config.canTrade).toBe(false);
      expect(r.config.account).toBeNull();
      expect(r.warnings.join(" ")).toContain("HT_AGENT_KEY");
      expect(leaks(r.warnings.join("\n"), bad)).toBe(false);
    }
  });

  test("an invalid HT_ACCOUNT is not echoed (it may be a misplaced key)", () => {
    const r = loadConfig({ HT_ACCOUNT: KEY }, []);
    expect(r.config.account).toBeNull();
    expect(r.warnings.join(" ")).toContain("HT_ACCOUNT");
    expect(leaks(r.warnings.join("\n"), KEY)).toBe(false);
  });

  test("mainnet with a key warns about real funds", () => {
    const r = loadConfig({ HT_NETWORK: "mainnet", HT_AGENT_KEY: KEY, HT_ACCOUNT: MASTER }, []);
    expect(r.config).toMatchObject({ network: "mainnet", canTrade: true });
    expect(r.warnings.join(" ")).toContain("MAINNET");
  });

  test("numeric overrides; bad or out-of-range values fall back to the default with a warning", () => {
    const r = loadConfig(
      {
        HT_MAX_RISK_PCT: "1",
        HT_MAX_OPEN_RISK_PCT: "abc",
        HT_MAX_GROSS_LEV: "50",
        HT_MAX_COIN_LEV: "2",
        HT_MAX_POSITIONS: "2.5",
        HT_MIN_RR: "2",
        HT_MAX_NOTIONAL_USD: "-5",
        HT_SLIPPAGE_PCT: "0.5",
      },
      [],
    );
    expect(r.config.limits).toEqual({ maxRiskPct: 1, maxOpenRiskPct: 2, maxGrossLeverage: 5, maxCoinLeverage: 2, maxPositions: 4, minRewardRisk: 2 });
    expect(r.config.maxNotionalUsd).toBe(1000);
    expect(r.config.slippage).toBeCloseTo(0.005, 12);
    const w = r.warnings.join("\n");
    for (const k of ["HT_MAX_OPEN_RISK_PCT", "HT_MAX_GROSS_LEV", "HT_MAX_POSITIONS", "HT_MAX_NOTIONAL_USD"]) expect(w).toContain(k);
    expect(r.warnings).toHaveLength(4);
    expect(loadConfig({ HT_MAX_NOTIONAL_USD: "250" }, []).config.maxNotionalUsd).toBe(250);
  });

  test("governorLimits keeps the desk's other limits", () => {
    const g = governorLimits(loadConfig({}, []).config.limits);
    expect(g).toMatchObject({ maxCoinLeverage: 3, maxGrossLeverage: 5, minStopPct: 0.5, maxStopPct: 15, minNotionalUsd: 10, takerFee: 0.00045 });
  });

  test("watch list and lab", () => {
    const r = loadConfig({ HT_WATCH: "btc, kPEPE,eth,BTC,bad!", LAB_URL: "https://lab.example.com/", LAB_API_TOKEN: "tok-secret" }, []);
    expect(r.config.watch).toEqual(["BTC", "kPEPE", "ETH"]);
    expect(r.config.lab).toEqual({ url: "https://lab.example.com", token: "tok-secret" });
    expect(r.warnings).toHaveLength(1);
    const half = loadConfig({ LAB_API_TOKEN: "tok-secret" }, []);
    expect(half.config.lab).toBeNull();
    expect(half.warnings.join(" ")).toContain("LAB_URL");
    expect(half.warnings.join(" ")).not.toContain("tok-secret");
  });
});
