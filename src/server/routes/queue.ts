import { Hono } from "hono";

export interface QueueRouteDeps {}

export function queueRoutes(_d: QueueRouteDeps) {
  return new Hono().get("/", (c) => c.json({ error: "unavailable", reason: "queue not built" }, 503));
}

export const defaultQueueDeps = (): QueueRouteDeps => ({});
