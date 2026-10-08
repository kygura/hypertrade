import { describe, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { actionHash, addressOf, agentDigest, signL1Action } from "./signing.js";
import { floatToWire, orderAction, roundPerpPx, slippagePx } from "./wire.js";

// Vectors from hyperliquid-python-sdk tests/signing_test.py. The SDK prints
// r/s via to_hex(int), which drops leading zeros, so compare as integers.
const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";
const big = (h: string) => BigInt(h);

function expectSig(sig: { r: string; s: string; v: number }, r: string, s: string, v: number) {
  expect(big(sig.r)).toBe(big(r));
  expect(big(sig.s)).toBe(big(s));
  expect(sig.v).toBe(v);
}

describe("signL1Action matches the Python SDK", () => {
  test("phantom agent connection id for a production order", () => {
    const action = orderAction([{ asset: 4, isBuy: true, limitPx: 1670.1, sz: 0.0147, reduceOnly: false, orderType: { limit: { tif: "Ioc" } } }]);
    expect(`0x${bytesToHex(actionHash(action, null, 1677777606040))}`).toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
  });

  test("dummy action, mainnet and testnet", () => {
    const action = { type: "dummy", num: 100000000000 }; // float_to_int_for_hashing(1000)
    expectSig(signL1Action(KEY, action, null, 0, null, true), "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298", "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8", 27);
    expectSig(signL1Action(KEY, action, null, 0, null, false), "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510", "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613", 28);
  });

  test("dummy action through a vault", () => {
    const action = { type: "dummy", num: 100000000000 };
    const vault = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
    expectSig(signL1Action(KEY, action, vault, 0, null, true), "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239", "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c", 28);
    expectSig(signL1Action(KEY, action, vault, 0, null, false), "0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b", "0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60", 27);
  });

  test("limit order", () => {
    const action = orderAction([{ asset: 1, isBuy: true, limitPx: 100, sz: 100, reduceOnly: false, orderType: { limit: { tif: "Gtc" } } }]);
    expectSig(signL1Action(KEY, action, null, 0, null, true), "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", 28);
    expectSig(signL1Action(KEY, action, null, 0, null, false), "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", 27);
  });

  test("limit order with a cloid", () => {
    const action = orderAction([
      { asset: 1, isBuy: true, limitPx: 100, sz: 100, reduceOnly: false, orderType: { limit: { tif: "Gtc" } }, cloid: "0x00000000000000000000000000000001" },
    ]);
    expectSig(signL1Action(KEY, action, null, 0, null, true), "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3", "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da", 27);
    expectSig(signL1Action(KEY, action, null, 0, null, false), "0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d", "0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988", 28);
  });

  test("trigger (stop-loss) order", () => {
    const action = orderAction([{ asset: 1, isBuy: true, limitPx: 100, sz: 100, reduceOnly: false, orderType: { trigger: { triggerPx: 103, isMarket: true, tpsl: "sl" } } }]);
    expectSig(signL1Action(KEY, action, null, 0, null, true), "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9", "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405", 27);
    expectSig(signL1Action(KEY, action, null, 0, null, false), "0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4", "0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac", 28);
  });

  test("createSubAccount action", () => {
    const action = { type: "createSubAccount", name: "example" };
    expectSig(signL1Action(KEY, action, null, 0, null, true), "0x51096fe3239421d16b671e192f574ae24ae14329099b6db28e479b86cdd6caa7", "0xb71f7d293af92d3772572afb8b102d167a7cef7473388286bc01f52a5c5b423", 27);
  });

  test("agent digests differ by network", () => {
    const h = new Uint8Array(32);
    expect(bytesToHex(agentDigest(h, true))).not.toBe(bytesToHex(agentDigest(h, false)));
  });

  test("addressOf derives the key's address", () => {
    // Well-known: private key 0x...01 → 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf
    expect(addressOf("0x" + "0".repeat(63) + "1")).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });
});

describe("wire formatting", () => {
  test("floatToWire matches float_to_wire", () => {
    expect(floatToWire(100)).toBe("100");
    expect(floatToWire(1670.1)).toBe("1670.1");
    expect(floatToWire(0.0147)).toBe("0.0147");
    expect(floatToWire(-0)).toBe("0");
    expect(floatToWire(0.00000001)).toBe("0.00000001");
    expect(() => floatToWire(0.000000001)).toThrow();
  });

  test("perp prices: 5 significant figures, at most 6 − szDecimals decimals", () => {
    expect(roundPerpPx(104123.7, 5)).toBe(104120);
    expect(roundPerpPx(3999.987, 4)).toBe(4000);
    expect(roundPerpPx(0.0123456, 0)).toBe(0.012346);
    expect(roundPerpPx(1.234567, 2)).toBe(1.2346);
    expect(slippagePx(100_000, true, 0.01, 5)).toBe(101_000);
    expect(slippagePx(4000, false, 0.01, 4)).toBe(3960);
  });
});
