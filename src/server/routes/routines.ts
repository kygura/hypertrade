import { Hono } from "hono";

interface TriggerRecord {
  requested_at: string;
  ok: boolean;
  error?: string;
}

// ponytail: in-memory only, resets on cold start. Fine here — the UI only
// needs "did the last trigger from this warm instance succeed", not a
// durable audit log (durable history would mean a DB table for one button).
let lastTrigger: TriggerRecord | null = null;

export const routinesRoutes = new Hono().post("/trigger", async (c) => {
  const requested_at = new Date().toISOString();
  const url = process.env.ROUTINE_WEBHOOK_URL;

  if (!url) {
    lastTrigger = { requested_at, ok: false, error: "ROUTINE_WEBHOOK_URL not set" };
    return c.json({ triggered: false, last_trigger: lastTrigger });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "hypertrade", requested_at }),
      signal: AbortSignal.timeout(5000),
    });
    lastTrigger = { requested_at, ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    lastTrigger = { requested_at, ok: false, error: err instanceof Error ? err.message : "request failed" };
  }

  return c.json({ triggered: lastTrigger.ok, last_trigger: lastTrigger });
});
