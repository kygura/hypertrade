// Hyperliquid order wire format, ported from hyperliquid-python-sdk
// (utils/signing.py float_to_wire, order_type_to_wire,
// order_request_to_order_wire, order_wires_to_order_action, and
// exchange.py _slippage_price). Object key order follows the SDK exactly:
// the signature covers the msgpack bytes, which keep insertion order.

export type Tif = "Gtc" | "Ioc" | "Alo";
export type OrderType = { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: number; tpsl: "tp" | "sl" } };

export interface OrderRequest {
  asset: number;
  isBuy: boolean;
  limitPx: number;
  sz: number;
  reduceOnly: boolean;
  orderType: OrderType;
  /** 16-byte client order id, "0x" + 32 hex. */
  cloid?: string;
}

/** float_to_wire: at most 8 decimals, no trailing zeros; throws when 8 decimals would round. */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire would round ${x}`);
  let s = rounded.includes(".") ? rounded.replace(/0+$/, "").replace(/\.$/, "") : rounded;
  if (s === "-0") s = "0";
  return s;
}

/**
 * A valid perp price: 5 significant figures, then at most 6 − szDecimals
 * decimals (the SDK's _slippage_price rounding).
 */
export function roundPerpPx(px: number, szDecimals: number): number {
  const decimals = Math.max(0, 6 - szDecimals);
  return Number(Number(px.toPrecision(5)).toFixed(decimals));
}

/** Marketable price: `slippage` through the mark, rounded to a valid perp price. */
export function slippagePx(mark: number, isBuy: boolean, slippage: number, szDecimals: number): number {
  return roundPerpPx(mark * (isBuy ? 1 + slippage : 1 - slippage), szDecimals);
}

export function orderTypeWire(t: OrderType) {
  if ("limit" in t) return { limit: { tif: t.limit.tif } };
  return { trigger: { isMarket: t.trigger.isMarket, triggerPx: floatToWire(t.trigger.triggerPx), tpsl: t.trigger.tpsl } };
}

export function orderWire(o: OrderRequest) {
  return {
    a: o.asset,
    b: o.isBuy,
    p: floatToWire(o.limitPx),
    s: floatToWire(o.sz),
    r: o.reduceOnly,
    t: orderTypeWire(o.orderType),
    ...(o.cloid ? { c: o.cloid } : {}),
  };
}

export function orderAction(orders: OrderRequest[], grouping: "na" | "normalTpsl" | "positionTpsl" = "na") {
  return { type: "order", orders: orders.map(orderWire), grouping };
}

export function cancelAction(cancels: Array<{ asset: number; oid: number }>) {
  return { type: "cancel", cancels: cancels.map((c) => ({ a: c.asset, o: c.oid })) };
}

export function updateLeverageAction(asset: number, isCross: boolean, leverage: number) {
  return { type: "updateLeverage", asset, isCross, leverage };
}
