import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, parseBlocks } from "./Markdown";

describe("parseBlocks", () => {
  test("headings, lists, tables, code, quotes and paragraphs", () => {
    const md = [
      "## Funding",
      "Crowded **longs** on SOL.",
      "",
      "- one",
      "- two",
      "  continued",
      "",
      "1. first",
      "2. second",
      "",
      "| Coin | 24h |",
      "|:-----|----:|",
      "| BTC | +2.1% |",
      "| ETH | -0.4% |",
      "",
      "```",
      "raw",
      "```",
      "> quoted",
    ].join("\n");
    expect(parseBlocks(md).map((b) => b.kind)).toEqual(["heading", "para", "list", "list", "table", "code", "quote"]);
    const list = parseBlocks("- one\n- two\n  continued")[0] as { items: string[] };
    expect(list.items).toEqual(["one", "two continued"]);
    const table = parseBlocks("| a | b |\n|:--|--:|\n| 1 | 2 |")[0] as { align: string[]; rows: string[][] };
    expect(table.align).toEqual(["left", "right"]);
    expect(table.rows).toEqual([["1", "2"]]);
  });

  test("an unterminated fence mid-stream renders as code so far", () => {
    expect(parseBlocks("```\npartial")).toEqual([{ kind: "code", lang: "", text: "partial" }]);
  });
});

describe("Markdown render", () => {
  test("never emits raw HTML from model text, and only links http(s)", () => {
    const html = renderToStaticMarkup(<Markdown text={'<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://ex.com)'} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://ex.com"');
  });

  test("signed numbers in table cells take the PnL colors", () => {
    const html = renderToStaticMarkup(<Markdown text={"| c | d |\n|---|---|\n| BTC | +2.1% |\n| ETH | -0.4% |"} />);
    expect(html).toMatch(/text-green[^>]*>\+2\.1%/);
    expect(html).toMatch(/text-red-text[^>]*>-0\.4%/);
  });
});
