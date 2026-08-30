// Formatters for portfolio numbers. Ported from hyperion/dashboard/src/lib/metric-fmt.ts.

export function fmtUsd(
  n: number,
  opts: { decimals?: number; sign?: boolean; compact?: boolean } = {},
): string {
  const { decimals = 2, sign = false, compact = false } = opts;
  if (!isFinite(n)) return "$--";
  const abs = Math.abs(n);
  let body: string;
  if (compact && abs >= 1_000_000_000_000) {
    body = `$${(abs / 1_000_000_000_000).toFixed(2)}T`;
  } else if (compact && abs >= 1_000_000_000) {
    body = `$${(abs / 1_000_000_000).toFixed(2)}B`;
  } else if (compact && abs >= 1_000_000) {
    body = `$${(abs / 1_000_000).toFixed(2)}M`;
  } else if (compact && abs >= 1_000) {
    body = `$${(abs / 1_000).toFixed(2)}K`;
  } else {
    body = `$${abs.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  }
  if (n < 0) return `-${body}`;
  if (sign && n > 0) return `+${body}`;
  return body;
}

// Unit contract: `n` is a FRACTION (0.021 -> "2.10%"), not a pre-scaled
// percent. Hyperliquid fields (funding, dayChange) are fractions already, so
// this is the natural fit there. Engine sim stats (cagrPct, vsBtcPct, …) are
// pre-scaled percents instead — divide by 100 before calling this.
export function fmtPct(
  n: number,
  opts: { decimals?: number; sign?: boolean } = {},
): string {
  const { decimals = 2, sign = false } = opts;
  if (!isFinite(n)) return "--%";
  const v = n * 100;
  const body = `${Math.abs(v).toFixed(decimals)}%`;
  if (v < 0) return `-${body}`;
  if (sign && v > 0) return `+${body}`;
  return body;
}

export function fmtPrice(n: number, decimals?: number): string {
  if (!isFinite(n)) return "--";
  const d = decimals ?? (n >= 1000 ? 2 : n >= 1 ? 3 : 5);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtDateShort(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function classForPnl(n: number): string {
  if (n > 0) return "text-green";
  if (n < 0) return "text-red-text";
  return "text-text-secondary";
}
