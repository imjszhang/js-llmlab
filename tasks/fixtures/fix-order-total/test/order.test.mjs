import assert from "node:assert/strict";
import test from "node:test";
import { quoteOrder } from "../src/order-service.mjs";

test("two physical items with an order discount", () => {
  assert.deepEqual(quoteOrder({ items: [{ price: "12.35", quantity: 2, physical: true }], couponBps: 1000 }), {
    subtotalCents: 2470, discountCents: 247, shippingCents: 499, totalCents: 2722,
  });
});

test("empty order", () => {
  assert.deepEqual(quoteOrder({ items: [] }), {
    subtotalCents: 0, discountCents: 0, shippingCents: 0, totalCents: 0,
  });
});
