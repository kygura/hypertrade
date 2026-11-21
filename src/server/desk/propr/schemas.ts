import { z } from "zod";

// Propr's answers, parsed at the boundary (as the HL broker does with OrderResponseSchema). A 200 in a shape the desk
// does not know must not read as "no orders, no positions": every guard that counts rows (entries per day, one
// executor per account, resting rungs, one position per coin, open risk) would pass. An unrecognised envelope throws,
// so the account reads as unavailable and the governor blocks. Rows are parsed one by one (client.ts): shapes that
// carry the same meaning are normalised here ("" for a missing number, an epoch for a timestamp, "false" for false,
// "LONG" for long), a row that cannot be live is dropped, and a row that may be live and cannot be read fails the
// read for new entries. Extra fields pass through untouched.

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const number = z.union([z.number().finite(), z.string().trim().refine((s) => Number.isFinite(Number(s)), "not a number")]);
/** A number or a numeric string; "" reads as missing. */
const numeric = z.preprocess(blank, number.nullish());
const required = z.preprocess(blank, number);
const lower = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : v);
/** Words the guards compare (status, type, side): read without case. */
const word = z.preprocess(lower, z.string().nullish());
const text = z.string().nullish();
const id = z.union([z.string(), z.number()]).nullish();
/** A timestamp as an ISO string, whether Propr sent a string or an epoch (seconds or milliseconds). */
const stamp = z.preprocess((v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{10,13}$/.test(v.trim()) ? Number(v) : null;
  if (n == null || !Number.isFinite(n)) return v;
  const d = new Date(n < 1e11 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}, z.string().nullish());
const flag = z.preprocess((v) => (typeof v === "string" ? ({ true: true, false: false } as Record<string, boolean>)[v.trim().toLowerCase()] ?? v : v), z.boolean().nullish());

export const RowSchema = z.record(z.unknown());
export type Row = z.infer<typeof RowSchema>;

/** A list answer: a bare array, or `{ data: [...], total? }`. Anything else is not a list. */
export const ListSchema = z.union([z.array(RowSchema), z.object({ data: z.array(RowSchema) }).passthrough()]);

/** An order row: its status and type decide whether it is open and whether it is an entry, so both are required. */
export const OrderRowSchema = z
  .object({
    status: z.preprocess(lower, z.string()),
    type: z.preprocess(lower, z.string()),
    orderId: id,
    intentId: text,
    orderGroupId: text,
    positionId: id,
    base: text,
    asset: text,
    side: word,
    positionSide: word,
    reduceOnly: flag,
    quantity: numeric,
    cumulativeQuantity: numeric,
    price: numeric,
    triggerPrice: numeric,
    createdAt: stamp,
  })
  .passthrough();

/** A position row: the coin, the side and the quantity are what the desk protects, so none may be missing. */
export const PositionRowSchema = z
  .object({
    quantity: required,
    positionSide: z.preprocess(lower, z.enum(["long", "short"])),
    base: text,
    asset: text,
    status: word,
    positionId: id,
    entryPrice: numeric,
    markPrice: numeric,
  })
  .passthrough()
  .refine((p) => !!(p.base || p.asset), "position has no coin (base or asset)");

export const TradeRowSchema = z.object({ executedAt: stamp, createdAt: stamp, realizedPnl: numeric, fee: numeric }).passthrough();

export const AttemptRowSchema = z.object({ accountId: z.string().nullish(), status: z.string() }).passthrough();

/** GET /accounts/{id}: an object carrying a balance (snapshotFrom checks it is positive). */
export const AccountSchema = z.object({ balance: required }).passthrough();

export const MarginConfigSchema = z.object({ configId: z.union([z.string(), z.number()]).transform(String), leverage: required, marginMode: z.string() }).passthrough();

const DONE = new Set(["filled", "cancelled", "canceled", "rejected", "expired", "closed", "failed"]);
/** An order row that cannot be read but is over (a terminal status): it rests nowhere, so it is dropped, not an error. */
export const orderIsOver = (r: Row) => typeof r.status === "string" && DONE.has(r.status.trim().toLowerCase());
/** A position row that cannot be read but holds nothing (closed, or a zero quantity): dropped, as readPositions drops a readable one. */
export const positionIsFlat = (r: Row) => {
  const q = typeof r.quantity === "number" ? r.quantity : typeof r.quantity === "string" && r.quantity.trim() !== "" ? Number(r.quantity) : NaN;
  return q === 0 || (typeof r.status === "string" && r.status.trim().toLowerCase() === "closed");
};
