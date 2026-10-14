import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorBoundary } from "./ErrorBoundary";

// SSR cannot run error boundaries, so the caught state is set by hand.
describe("ErrorBoundary", () => {
  test("a thrown render becomes state, then a message with RETRY", () => {
    const state = ErrorBoundary.getDerivedStateFromError(new Error("boom"));
    expect(state.error.message).toBe("boom");
    const b = new ErrorBoundary({ children: null });
    b.state = { ...state, attempt: 0 };
    const html = renderToStaticMarkup(b.render());
    expect(html).toContain("boom");
    expect(html).toContain("RETRY");
  });

  test("healthy children render untouched", () => {
    expect(renderToStaticMarkup(<ErrorBoundary><p>ok</p></ErrorBoundary>)).toContain("<p>ok</p>");
  });
});
