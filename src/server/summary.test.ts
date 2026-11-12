import { expect, test } from "bun:test";
import { summaryFor } from "./db.js";
import { newPglite, pgliteSql } from "./testing/pglite.js";

// summaryFor reads each series' newest 90 rows off the (series_id, ts) key. Checked here against the
// same numbers worked out in plain code, on a series longer than 90 rows, a short one and an empty one.
test("summaryFor: latest, previous and the 30/90 stats come from the newest rows of each series", async () => {
  const pg = newPglite();
  await pg.exec(`
    create table series (id text primary key);
    create table observations (series_id text not null references series (id), ts timestamptz not null, value double precision not null, primary key (series_id, ts));
    insert into series values ('long'), ('short'), ('empty'), ('other');
  `);
  const value = (i: number) => Math.sin(i) * 100 + i;
  const fill = async (id: string, n: number) => {
    for (let i = 0; i < n; i++) await pg.query(`insert into observations values ($1, $2, $3)`, [id, new Date(Date.UTC(2026, 0, 1) + i * 900_000).toISOString(), value(i)]);
  };
  await fill("long", 200);
  await fill("short", 3);
  await fill("other", 5);

  const got = await summaryFor(["long", "short", "empty"], pgliteSql(pg));
  const by = new Map(got.map((r) => [r.seriesId, r]));
  expect([...by.keys()].sort()).toEqual(["long", "short"]);

  const stats = (xs: number[]) => {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return { mean, sd: Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) };
  };
  const newest = Array.from({ length: 200 }, (_, i) => value(i)).reverse();
  const long = by.get("long")!;
  expect(long.latest).toBeCloseTo(newest[0]!, 9);
  expect(long.delta).toBeCloseTo(newest[0]! - newest[1]!, 9);
  expect(new Date(long.ts!).toISOString()).toBe(new Date(Date.UTC(2026, 0, 1) + 199 * 900_000).toISOString());
  expect(long.mean30).toBeCloseTo(stats(newest.slice(0, 30)).mean, 6);
  expect(long.stddev30).toBeCloseTo(stats(newest.slice(0, 30)).sd, 6);
  expect(long.mean90).toBeCloseTo(stats(newest.slice(0, 90)).mean, 6);
  expect(long.stddev90).toBeCloseTo(stats(newest.slice(0, 90)).sd, 6);
  expect(by.get("short")!.latest).toBeCloseTo(value(2), 9);
  expect(by.get("short")!.mean90).toBeCloseTo(stats([value(0), value(1), value(2)]).mean, 6);
});
