// Number validator (SPEC.md § Flow F0.5). Pure. Every number an LLM line
// prints must match a number in the call's input payload within rounding, and
// the line must carry no buy/sell/enter/exit imperative or price target.
// claims.ts `validateLines` applies it; failing lines are dropped and counted.

export interface NumToken {
  value: number;
  /** One step of the last printed decimal, in the token's scale ("$12.4M" → 100 000). */
  unit: number;
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(?:[12]\\d|3[01]|0?[1-9])(?:st|nd|rd|th)?";

/** Spans that are never checked: dates, times, ordinals ≤ 31 in a date phrase, list markers. */
const EXEMPT = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/gi,
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:am|pm|utc|et|z)\b)?/gi,
  /\b\d{1,2}\s?(?:am|pm)\b/gi,
  new RegExp(`\\b${MONTH}\\s+${DAY}(?:,?\\s+\\d{4})?\\b`, "gi"),
  new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?\\b`, "gi"),
  new RegExp(`\\b${MONTH}\\s+\\d{4}\\b`, "gi"),
  /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])(?:\/\d{2,4})?\b/g,
  /^[\s\-•*]*\(?\d{1,2}[.)](?=\s)/gm,
];

// A digit run not glued to a word, a decimal point, or a "letter-"/"letter:" prefix (EIP-1967, desk:BTC:1).
const NUMBER = /(?<![\w.]|[A-Za-z][-:])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(%|bps?\b|thousand\b|million\b|billion\b|trillion\b)|(bn|mn|[kmb])(?![A-Za-z]))?/gi;
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, trillion: 1e12 };

/** Numeric tokens of an LLM line, exempt ones skipped. Signs are dropped (direction is usually in words). */
export function extractNumbers(text: string): NumToken[] {
  let t = text;
  for (const re of EXEMPT) t = t.replace(re, (s) => " ".repeat(s.length));
  const out: NumToken[] = [];
  for (const m of t.matchAll(NUMBER)) {
    const [whole, int, dec = "", word, letter] = m;
    if (!word && !letter) {
      const rest = t.slice(m.index! + whole.length);
      if (/^\s?[hdw]\b/i.test(rest)) continue; // window label: 1h, 24h, 7d, 48 h
      if (/^[a-z_]/i.test(rest) && !/^(?:st|nd|rd|th|x)\b/i.test(rest)) continue; // identifier: 2FA, 0x1f…
    }
    const scale = SCALE[(word ?? letter ?? "").toLowerCase()] ?? 1;
    out.push({ value: Number(`${int!.replace(/,/g, "")}.${dec || "0"}`) * scale, unit: 10 ** -dec.length * scale });
  }
  return out;
}

const PLAIN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Every number in a call's input payload, absolute: numeric fields, and numbers inside strings (JSON strings are parsed). */
export function payloadNumbers(payload: unknown, out: number[] = []): number[] {
  if (typeof payload === "number") {
    if (Number.isFinite(payload)) out.push(Math.abs(payload));
  } else if (typeof payload === "string") {
    const s = payload.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return payloadNumbers(JSON.parse(s), out);
      } catch {
        // not JSON: scan as text
      }
    }
    for (const m of s.match(PLAIN) ?? []) out.push(Number(m.replace(/,/g, "")));
    for (const n of extractNumbers(s)) out.push(n.value);
  } else if (payload && typeof payload === "object") {
    for (const v of Object.values(payload)) payloadNumbers(v, out);
  }
  return out;
}

const VERB = "(?:buy|sell|enter|exit)";
const NOT_NOUN = "(?!-|\\s+(?:liquidity|volume|pressure|side|walls?|orders?|flows?|ratio|signals?|interest)\\b)";
const ADVICE = [
  // ponytail: imperative = verb at a clause start or after an advisory lead-in; a parser would catch more phrasings.
  new RegExp(`(?:^[\\s\\-•*]*|[.!?:;—–]\\s*)${VERB}\\b${NOT_NOUN}`, "i"),
  new RegExp(`\\b(?:should|could|consider|recommend\\w*|time to|better to|you|we)\\s+${VERB}(?:ing)?\\b${NOT_NOUN}`, "i"),
  /\btargets?\b|\bwill\s+reach\b/i,
  /\bTP\d?\b/,
];

export function isAdvice(text: string): boolean {
  return ADVICE.some((re) => re.test(text));
}

/** Within rounding: relative 0.5 %, or one unit of the last printed decimal. */
const near = (t: NumToken, p: number) => Math.abs(t.value - p) <= Math.max(0.005 * p, t.unit) * (1 + 1e-9);

/** Why a line must be dropped, or null when it passes. `payload` = payloadNumbers(input). */
export function lineVerdict(text: string, payload: number[]): "advice" | "numbers" | null {
  if (isAdvice(text)) return "advice";
  return extractNumbers(text).every((t) => payload.some((p) => near(t, p))) ? null : "numbers";
}
