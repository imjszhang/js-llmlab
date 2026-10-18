export function discountCents(subtotalCents, couponBps) {
  return Math.floor(subtotalCents * couponBps / 10000);
}
