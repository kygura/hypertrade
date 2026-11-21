import { z } from "zod";

// Propr's answers, parsed at the boundary (as the HL broker does with OrderResponseSchema). A 200 in a shape the desk
// does not know must not read as "no orders, no positions": every guard that counts rows (entries per day, one
// executor per account, resting rungs, one position per coin, open risk) would pass. An unrecognised answer throws, so
// the account reads as unavailable and the governor blocks. Extra fields pass through untouched.

const numeric = z.union([z.number().finite(), z.string().trim().min(1).refine((s) => Number.isFinite(Number(s)), "not a number")]);
const text = z.string().nullish();
const id = z.union([z.string(), z.number()]).nullish();

export const RowSchema = z.record(z.unknown());
export type Row = z.infer<typeof RowSchema>;

/** A list answer: a bare array, or `{ data: [...], total? }`. Anything else is not a list. */
export const ListSchema = z.union([z.array(RowSchema), z.object({ data: z.array(RowSchema), total: z.number().nullish() }).passthrough()]);

/** An order row: its status and type decide whether it is open and whether it is an entry, so both are required. */
export const OrderRowSchema = z
  .object({
    status: z.string(),
    type: z.string(),
    orderId: id,
    intentId: text,
    orderGroupId: text,
    positionId: id,
    base: text,
    asset: text,
    side: text,
    positionSide: text,
    reduceOnly: z.boolean().nullish(),
    quantity: numeric.nullish(),
    cumulativeQuantity: numeric.nullish(),
    price: numeric.nullish(),
    triggerPrice: numeric.nullish(),
    createdAt: text,
  })
  .passthrough();

/** A position row: the coin, the side and the quantity are what the desk protects, so none may be missing. */
export const PositionRowSchema = z
  .object({
    quantity: numeric,
    positionSide: z.enum(["long", "short"]),
    base: text,
    asset: text,
    status: text,
    positionId: id,
    entryPrice: numeric.nullish(),
    markPrice: numeric.nullish(),
  })
  .passthrough()
  .refine((p) => !!(p.base || p.asset), "position has no coin (base or asset)");

export const TradeRowSchema = z.object({ executedAt: text, createdAt: text, realizedPnl: numeric.nullish(), fee: numeric.nullish() }).passthrough();

export const AttemptRowSchema = z.object({ accountId: z.string().nullish(), status: z.string() }).passthrough();

/** GET /accounts/{id}: an object carrying a balance (snapshotFrom checks it is positive). */
export const AccountSchema = z.object({ balance: numeric }).passthrough();

export const MarginConfigSchema = z.object({ configId: z.union([z.string(), z.number()]).transform(String), leverage: numeric, marginMode: z.string() }).passthrough();
