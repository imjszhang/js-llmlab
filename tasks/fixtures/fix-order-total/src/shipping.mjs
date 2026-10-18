export function shippingCents(netMerchandiseCents, hasPhysicalItems) {
  if (!hasPhysicalItems || netMerchandiseCents >= 5000) return 0;
  return 499;
}
