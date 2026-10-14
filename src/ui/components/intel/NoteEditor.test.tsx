import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TradeNote } from "../../../shared/intel";
import { NOTE_MAX, NoteEditor, submitNote } from "./NoteEditor";

// NoteEditor (DESIGN-terminal §4.2): the save step is pure apart from the
// injected `save`, so it is tested directly; markup via react-dom/server.

const tradeId = "hl:BTC:8812";
const saved: TradeNote = { tradeId, note: "faded the open", tag: "breakout", summary: null, updatedAt: "2026-10-12T10:00:00Z" };

describe("submitNote", () => {
  test("trims the draft, sends it for the trade and returns the saved note", async () => {
    const calls: [string, string][] = [];
    const r = await submitNote(
      async (id, note) => {
        calls.push([id, note]);
        return saved;
      },
      tradeId,
      "  faded the open  ",
    );
    expect(calls).toEqual([[tradeId, "faded the open"]]);
    expect(r).toEqual({ ok: true, note: saved });
  });

  test("caps at 280 chars and sends an empty string to clear", async () => {
    const sent: string[] = [];
    const save = async (_: string, note: string) => {
      sent.push(note);
      return saved;
    };
    await submitNote(save, tradeId, "x".repeat(400));
    await submitNote(save, tradeId, "   ");
    expect(sent[0]).toHaveLength(NOTE_MAX);
    expect(sent[1]).toBe("");
  });

  test("a failed save surfaces the server message verbatim", async () => {
    const r = await submitNote(
      async () => {
        throw new Error("invalid trade id");
      },
      tradeId,
      "note",
    );
    expect(r).toEqual({ ok: false, error: "invalid trade id" });
  });
});

describe("NoteEditor markup", () => {
  test("labelled textarea, 280 cap, counter, SAVE NOTE disabled until edited", () => {
    const html = renderToStaticMarkup(<NoteEditor tradeId={tradeId} note="faded the open" onSaved={() => {}} save={async () => saved} />);
    expect(html).toContain(">NOTE</label>");
    expect(html).toContain('maxLength="280"');
    expect(html).toContain('rows="3"');
    expect(html).toContain("faded the open</textarea>");
    expect(html).toMatch(/>14(<!-- -->)?\/(<!-- -->)?280</);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>SAVE NOTE<\/span>/);
  });
});
