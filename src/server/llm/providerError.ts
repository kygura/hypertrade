/** Provider failures without leaking request details (keys never appear here). `noun` names the caller ("analyst provider", "model provider"). */
export function providerError(err: unknown, noun: string): string {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    const status = (err as { status: number }).status;
    if (status === 401 || status === 403) return `${noun} rejected the credentials`;
    if (status === 429) return `${noun} is rate limiting; try again shortly`;
    return `${noun} error (HTTP ${status})`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `${noun} error: ${msg.slice(0, 200)}`;
}
