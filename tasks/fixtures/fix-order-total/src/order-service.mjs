import { toCents } from "./money.mjs";
import { discountCents as calculateDiscount } from "./discounts.mjs";
import { shippingCents as calculateShipping } from "./shipping.mjs";

export function quoteOrder(order) {
  if (!order || !Array.isArray(order.items)) throw new RangeError("items must be an array");
  const couponBps = order.couponBps === undefined ? 0 : order.couponBps;
  if (!Number.isInteger(couponBps) || couponBps < 0 || couponBps > 10000) {
    throw new RangeError("couponBps must be an integer from 0 to 10000");
  }
  let subtotalCents = 0;
  let hasPhysicalItems = false;
  for (const item of order.items) {
    if (!item || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100
        || typeof item.physical !== "boolean") {
      throw new RangeError("invalid item");
    }
    subtotalCents += toCents(item.price);
    hasPhysicalItems ||= item.physical;
  }
  const discountCents = calculateDiscount(subtotalCents, couponBps);
  const shippingCents = calculateShipping(subtotalCents, hasPhysicalItems);
  return { subtotalCents, discountCents, shippingCents, totalCents: subtotalCents - discountCents + shippingCents };
}
