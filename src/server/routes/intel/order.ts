import { Hono, type Context } from "hono";
import { OrderConfirmRequestSchema, OrderPreviewRequestSchema } from "../../../shared/intel.js";
import { DeskError } from "../../desk/service.js";
import { confirmOrder, OrderError, previewOrder, type CopilotDeps } from "../../intel/copilot.js";

// /api/intel/order — the order copilot (SPEC.md § Intel I0.18). Session-cookie
// protected by the global gate. Nothing here executes without the confirm
// call, and confirm only goes through with the hash of the latest preview.
//
// POST /order/preview {text} | {intent} → OrderPreview (verdict, previewHash, expiresAt)
// POST /order/confirm {intent, previewHash} → OrderConfirmResponse; 409 when stale or mismatched

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function orderError(c: Context, err: unknown) {
  if (err instanceof OrderError) return c.json({ error: err.message, ...(err.field ? { field: err.field } : {}) }, err.status);
  if (err instanceof DeskError) return c.json({ error: err.message }, err.status);
  console.error("[intel/order]", err);
  return c.json({ error: err instanceof Error ? err.message : "order error" }, 500);
}

export function createOrderRoutes(deps: CopilotDeps | (() => CopilotDeps)) {
  const get = typeof deps === "function" ? deps : () => deps;
  return new Hono()
    .post("/order/preview", async (c) => {
      const parsed = OrderPreviewRequestSchema.safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid order preview: send {text} or {intent}", field: parsed.error.issues[0]?.path.join(".") }, 400);
      try {
        return c.json(await previewOrder(get(), parsed.data));
      } catch (err) {
        return orderError(c, err);
      }
    })
    .post("/order/confirm", async (c) => {
      const parsed = OrderConfirmRequestSchema.safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid order confirm: send {intent, previewHash}", field: parsed.error.issues[0]?.path.join(".") }, 400);
      try {
        return c.json(await confirmOrder(get(), parsed.data));
      } catch (err) {
        return orderError(c, err);
      }
    });
}
