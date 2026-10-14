import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DslEditor, validateDsl } from "./DslEditor";
import { QueryRunBar, canRun } from "./QueryRunBar";

// DslEditor + RUN gating (DESIGN-terminal §6.2): invalid JSON and DSL the
// shared ScreenerDslSchema rejects both keep RUN disabled.

const good = JSON.stringify({ source: "snapshots", select: ["asset", "funding"], assets: ["SOL"], since_h: 24 }, null, 2);

describe("validateDsl", () => {
  test("empty → empty, valid → parsed DSL with defaults", () => {
    expect(validateDsl("  ")).toEqual({ kind: "empty" });
    const v = validateDsl(good);
    expect(v.kind).toBe("valid");
    if (v.kind === "valid") expect(v.dsl.limit).toBe(100);
  });

  test("invalid JSON → invalid with the parse error", () => {
    const v = validateDsl('{\n  "source": "snapshots",\n}');
    expect(v.kind).toBe("invalid");
  });

  test("schema reject names the path", () => {
    const v = validateDsl(JSON.stringify({ source: "snapshots", select: ["nope"] }));
    expect(v).toEqual({ kind: "invalid", error: "select.0: unknown column for snapshots: nope" });
    expect(validateDsl(JSON.stringify({ source: "snapshots", select: ["asset"], limit: 900 })).kind).toBe("invalid");
  });
});

describe("RUN gating", () => {
  test("canRun only for a valid DSL and not while running", () => {
    expect(canRun({ kind: "empty" }, false)).toBe(false);
    expect(canRun(validateDsl("{"), false)).toBe(false);
    expect(canRun(validateDsl(JSON.stringify({ source: "observations", select: ["value"], assets: ["BTC"] })), false)).toBe(false);
    expect(canRun(validateDsl(good), true)).toBe(false);
    expect(canRun(validateDsl(good), false)).toBe(true);
  });

  test("RUN renders disabled for a schema reject, enabled for a valid DSL", () => {
    const runBtn = (html: string) => /<button[^>]*>(?:(?!<\/button>).)*RUN<\/span><\/button>/.exec(html)?.[0] ?? "";
    const rejected = renderToStaticMarkup(<QueryRunBar validation={validateDsl('{"source":"funding","select":["oi_usd"]}')} running={false} onRun={() => {}} />);
    expect(runBtn(rejected)).toContain('disabled=""');
    const ok = renderToStaticMarkup(<QueryRunBar validation={validateDsl(good)} running={false} onRun={() => {}} />);
    expect(runBtn(ok)).not.toContain('disabled=""');
    expect(ok).toContain("read-only · 5 s timeout · ≤ 500 rows · ≤ 90 days");
  });
});

describe("DslEditor markup", () => {
  test("validity line: ✗ error in red, ✓ valid JSON otherwise", () => {
    const bad = renderToStaticMarkup(<DslEditor value="{" onChange={() => {}} error="line 1: Unexpected end of JSON input" />);
    expect(bad).toContain("✗ line 1: Unexpected end of JSON input");
    expect(bad).toContain("text-red-text");
    expect(bad).toContain('aria-invalid="true"');
    expect(bad).toContain('spellCheck="false"');
    const ok = renderToStaticMarkup(<DslEditor value={good} onChange={() => {}} />);
    expect(ok).toContain("✓ valid JSON");
    expect(ok).not.toContain("aria-invalid");
  });
});
