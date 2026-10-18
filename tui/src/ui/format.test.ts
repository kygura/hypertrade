import { describe, expect, test } from "bun:test";
import { fitColumns, type Column } from "./Table.js";
import { wrapSegs } from "./segs.js";
import {
  fmtAge,
  fmtApr,
  fmtBps,
  fmtDist,
  fmtFundingH,
  fmtLev,
  fmtPct,
  fmtPx,
  fmtSz,
  fmtUsd,
  fmtUsdCompact,
  pxDecimals,
  shortAddr,
  wrapText,
} from "./format.js";

describe("format", () => {
  test("prices: 5 significant figures, tick cap 6 − szDecimals, aligned per coin", () => {
    expect(fmtPx(61170, 5)).toBe("61,170.0");
    expect(fmtPx(3338.9, 4)).toBe("3,338.9");
    expect(fmtPx(142.39, 2)).toBe("142.39");
    expect(fmtPx(0.012345, 0)).toBe("0.012345");
    expect(fmtPx(59946.62, 5)).toBe("59,946.6");
    expect(fmtPx(41050, 5, 61170)).toBe("41,050.0");
    expect(fmtPx(98.5, 2, 142.39)).toBe("98.50");
    expect(pxDecimals(61170, 5)).toBe(1);
    expect(pxDecimals(0.5, 6)).toBe(0);
    expect(fmtPx(null, 2)).toBe("—");
  });

  test("sizes: exactly szDecimals", () => {
    expect(fmtSz(0.045, 5)).toBe("0.04500");
    expect(fmtSz(1.2, 4)).toBe("1.2000");
    expect(fmtSz(1500, 0)).toBe("1,500");
  });

  test("usd", () => {
    expect(fmtUsd(12345.67)).toBe("$12,345.67");
    expect(fmtUsd(34.11, { sign: true })).toBe("+$34.11");
    expect(fmtUsd(-31.2, { sign: true })).toBe("-$31.20");
    expect(fmtUsd(2210, { decimals: 0 })).toBe("$2,210");
    expect(fmtUsd(2_500_000)).toBe("$2.50M");
    expect(fmtUsdCompact(2.41e9)).toBe("$2.41B");
    expect(fmtUsdCompact(612e6)).toBe("$612M");
    expect(fmtUsdCompact(61.2e6)).toBe("$61.2M");
    expect(fmtUsdCompact(12_340)).toBe("$12.3K");
    expect(fmtUsdCompact(950)).toBe("$950");
    expect(fmtUsdCompact(999_700)).toBe("$1.00M");
    expect(fmtUsdCompact(63e6)).toBe("$63.0M");
  });

  test("percent, distance, funding, apr, bps, leverage", () => {
    expect(fmtPct(1.2449)).toBe("+1.24%");
    expect(fmtPct(-2.1)).toBe("-2.10%");
    expect(fmtPct(0)).toBe("0.00%");
    expect(fmtPct(123.4)).toBe("+123%");
    expect(fmtDist(-3.21)).toBe("-3.2%");
    expect(fmtFundingH(0.000013)).toBe("0.0013%");
    expect(fmtFundingH(-0.000016)).toBe("-0.0016%");
    expect(fmtApr(11.39)).toBe("+11.4%");
    expect(fmtApr(-14.2)).toBe("-14.2%");
    expect(fmtBps(2.14)).toBe("2.1 bps");
    expect(fmtBps(14.4)).toBe("14 bps");
    expect(fmtLev(3)).toBe("3x");
  });

  test("ages and addresses", () => {
    expect(fmtAge(6_400)).toBe("6s");
    expect(fmtAge(4 * 60_000)).toBe("4m");
    expect(fmtAge(2 * 3_600_000)).toBe("2h");
    expect(fmtAge(3 * 86_400_000)).toBe("3d");
    expect(shortAddr("0x3fA2000000000000000000000000000000091c0")).toBe("0x3fA2…91c0");
  });

  test("wrap with hanging indent", () => {
    expect(wrapText("aaa bbb ccc ddd", 8, 2)).toEqual(["aaa bbb", "  ccc", "  ddd"]);
    const l = wrapSegs([{ text: "! " , tone: "warn" }, { text: "one two three four" }], 10, 2);
    expect(l.map((x) => x.map((s) => s.text).join(""))).toEqual(["! one two", "  three", "  four"]);
  });

  test("fitColumns drops highest dropRank first", () => {
    const col = (key: string, width: number, dropRank: number): Column<null> => ({ key, header: key, width, align: "left", dropRank, render: () => ({ text: "" }) });
    const cols = [col("a", 10, 0), col("b", 10, 2), col("c", 10, 1), col("d", 10, 3)];
    expect(fitColumns(cols, 43).map((c) => c.key)).toEqual(["a", "b", "c", "d"]);
    expect(fitColumns(cols, 32).map((c) => c.key)).toEqual(["a", "b", "c"]);
    expect(fitColumns(cols, 21).map((c) => c.key)).toEqual(["a", "c"]);
    expect(fitColumns(cols, 5).map((c) => c.key)).toEqual(["a"]);
  });
});
