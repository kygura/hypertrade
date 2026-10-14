import { Hono } from "hono";
import { OrderConfirmRequestSchema, OrderPreviewRequestSchema } from "../../../shared/intel.js";
import { confirmOrder, previewOrder, type CopilotDeps } from "../../intel/copilot.js";
import { body, failure } from "./http.js";

// /api/intel/order — the order copilot (SPEC.md § Intel I0.18). Session-cookie
// protected by the global gate. Nothing here executes without the confirm
// call, and confirm only goes through with the hash of the latest preview.
//
// POST /order/preview {text} | {intent} → OrderPreview (verdict, previewHash, expiresAt)
// POST /order/confirm {intent, previewHash} → OrderConfirmResponse; 409 when stale or mismatched

export function createOrderRoutes(get: () => CopilotDeps) {
  return new Hono()
    .post("/order/preview", async (c) => {
      const parsed = OrderPreviewRequestSchema.safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid order preview: send {text} or {intent}", field: parsed.error.issues[0]?.path.join(".") }, 400);
      try {
        return c.json(await previewOrder(get(), parsed.data));
      } catch (err) {
        return failure(c, err, "intel:order", "order error");
      }
    })
    .post("/order/confirm", async (c) => {
      const parsed = OrderConfirmRequestSchema.safeParse(await body(c));
      if (!parsed.success) return c.json({ error: "invalid order confirm: send {intent, previewHash}", field: parsed.error.issues[0]?.path.join(".") }, 400);
      try {
        return c.json(await confirmOrder(get(), parsed.data));
      } catch (err) {
        return failure(c, err, "intel:order", "order error");
      }
    });
}
