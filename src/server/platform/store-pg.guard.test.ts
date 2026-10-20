import { expect, test } from "bun:test";

// postgres.js (prepare:false, fetch_types:false) JSON-encodes a param typed jsonb again, so a
// pre-stringified value lands as a JSON string scalar. Params must be `$N::text::jsonb` (as db.ts:383).
// PGlite cannot reproduce this, hence the source guard.
test("store-pg.ts has no $N::jsonb param casts", async () => {
  const src = await Bun.file(new URL("./store-pg.ts", import.meta.url)).text();
  expect(src).not.toMatch(/\$\d+::jsonb/);
});
