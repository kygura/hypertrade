import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { THEMES } from "../themes/registry";
import { ThemeCycle } from "./ThemeSwitcher";

describe("ThemeCycle (phone top strip)", () => {
  test("shows the current theme's short code and names the next theme", () => {
    const html = renderToStaticMarkup(<ThemeCycle />);
    const [cur, next] = [THEMES[0]!, THEMES[1]!];
    expect(html).toContain(`>${cur.short}<`);
    expect(html).toContain(`switch to ${next.label}`);
  });
});
