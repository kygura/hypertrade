import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { KillSwitchDialog } from "./KillSwitchDialog";
import { flipDeskKill } from "../lib/useDeskKill";

// SSR render-check plus the hook's pure core (no DOM in this repo's tests).
const noop = () => {};
const dialog = (p: Partial<Parameters<typeof KillSwitchDialog>[0]> = {}) =>
  renderToStaticMarkup(<KillSwitchDialog killOn={false} busy={false} error={null} onConfirm={noop} onCancel={noop} {...p} />);

describe("KillSwitchDialog", () => {
  test("arming the kill asks for the typed word and starts disabled", () => {
    const html = dialog();
    expect(html).toContain("TYPE KILL TO CONFIRM");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*?KILL/s);
  });

  test("resuming needs no typed word", () => {
    const html = dialog({ killOn: true });
    expect(html).not.toContain("TYPE KILL");
    expect(html).toContain("RESUME");
  });

  test("a failed flip shows the verbatim error", () => {
    expect(dialog({ error: "desk down" })).toContain("desk down");
  });
});

describe("flipDeskKill", () => {
  test("posts the requested state and refetches", async () => {
    const calls: boolean[] = [];
    let refetched = 0;
    const err = await flipDeskKill(true, () => void refetched++, async (on) => void calls.push(on));
    expect(err).toBeNull();
    expect(calls).toEqual([true]);
    expect(refetched).toBe(1);
  });

  test("a failure returns the message and still refetches", async () => {
    let refetched = 0;
    const err = await flipDeskKill(false, () => void refetched++, async () => {
      throw new Error("desk down");
    });
    expect(err).toBe("desk down");
    expect(refetched).toBe(1);
  });
});
