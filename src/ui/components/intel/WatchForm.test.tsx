import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchForm, EMPTY_WATCH_FORM } from "./WatchForm";
import { ADDRESS_ERROR, ASSET_ERROR, CHAIN_ERROR, diffLineKind, shortTarget, URL_ERROR, validateWatchForm, type WatchFormValues } from "./watch";

// WatchForm client validation (DESIGN-terminal §8.2): https URL, 0x address,
// chain, required asset. Pure function + a render-check of the fields.

const v = (over: Partial<WatchFormValues>): WatchFormValues => ({ ...EMPTY_WATCH_FORM, ...over });
const ADDR = "0x1234567890abcdef1234567890abcdef1234cdef";

describe("validateWatchForm", () => {
  test("url: https only, no plain http, no local hosts", () => {
    expect(validateWatchForm(v({ target: "http://docs.jito.network/fees", asset: "SOL" })).errors?.target).toBe(URL_ERROR);
    expect(validateWatchForm(v({ target: "https://localhost/x", asset: "SOL" })).errors?.target).toBe(URL_ERROR);
    expect(validateWatchForm(v({ target: "not a url", asset: "SOL" })).errors?.target).toBe(URL_ERROR);
    const ok = validateWatchForm(v({ target: "https://docs.jito.network/fees", asset: "sol" }));
    expect(ok.errors).toBeUndefined();
    expect(ok.input).toEqual({ kind: "url", target: "https://docs.jito.network/fees", asset: "SOL", label: "docs.jito.network/fees" });
  });

  test("contract / wallet: 0x + 40 hex and a known chain", () => {
    expect(validateWatchForm(v({ kind: "evm_contract", target: "0x1234", asset: "ENA" })).errors?.target).toBe(ADDRESS_ERROR);
    expect(validateWatchForm(v({ kind: "evm_wallet", target: `${ADDR}00`, asset: "ARB" })).errors?.target).toBe(ADDRESS_ERROR);
    expect(validateWatchForm(v({ kind: "evm_contract", target: ADDR, chain: "", asset: "ENA" })).errors?.chain).toBe(CHAIN_ERROR);
    const ok = validateWatchForm(v({ kind: "evm_wallet", target: ADDR, chain: "arbitrum", asset: "ARB", label: "treasury" }));
    expect(ok.input).toEqual({ kind: "evm_wallet", target: ADDR, chain: "arbitrum", asset: "ARB", label: "treasury" });
  });

  test("asset is required", () => {
    expect(validateWatchForm(v({ target: "https://docs.jito.network/fees" })).errors?.asset).toBe(ASSET_ERROR);
    expect(validateWatchForm(v({ target: "https://docs.jito.network/fees", asset: "SO L" })).errors?.asset).toBe(ASSET_ERROR);
  });

  test("helpers: short target, diff line tone", () => {
    expect(shortTarget("evm_contract", ADDR)).toBe("0x1234…cdef");
    expect(shortTarget("url", "https://www.docs.jito.network/fees/")).toBe("docs.jito.network/fees");
    expect(diffLineKind("+ new fee 8%")).toBe("add");
    expect(diffLineKind("- old fee 5%")).toBe("del");
    expect(diffLineKind("unchanged")).toBe("ctx");
  });
});

describe("WatchForm render", () => {
  test("labelled fields; CHAIN only for addresses; URL hint", () => {
    const url = renderToStaticMarkup(<WatchForm onAdded={() => {}} onCancel={() => {}} />);
    expect(url).toContain('role="radiogroup"');
    expect(url).toContain(">TARGET<");
    expect(url).toContain(">ASSET<");
    expect(url).not.toContain(">CHAIN<");
    expect(url).toContain("JS-rendered or bot-blocked pages fail visibly");
    const contract = renderToStaticMarkup(<WatchForm onAdded={() => {}} onCancel={() => {}} initial={v({ kind: "evm_contract" })} />);
    expect(contract).toContain(">CHAIN<");
    expect(contract).toContain('value="hyperevm"');
  });
});
