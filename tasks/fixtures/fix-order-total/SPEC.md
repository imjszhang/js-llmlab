# Order quote repair task

Specification date: 2026-10-17. Node.js >= 20; no dependencies.

Repair the existing modules in `src/` to meet this contract. Preserve the
exported names and CLI interface. You may edit only the five existing
`src/*.mjs` files. Do not add files or change this specification, package.json,
or the visible tests. Additional acceptance tests are run outside the workspace.

`quoteOrder(order)` in `src/order-service.mjs` accepts:

```json
{
  "items": [{ "price": "12.35", "quantity": 2, "physical": true }],
  "couponBps": 1000
}
```

- `items` is an array, including an empty array. Each item's `price` is a
  nonnegative decimal string matching `^(0|[1-9]\d*)(\.\d{1,2})?$` (for example
  `0`, `0.5`, `12.35`; reject `1.`, `.50`, and `01.20`).
  `toCents(price)` in `src/money.mjs` must convert it
  exactly to integer cents. Invalid price strings throw `RangeError`.
- `quantity` is an integer from 1 to 100. `physical` is a boolean.
  Invalid item fields or a missing/non-array `items` throw `RangeError`.
- `couponBps` defaults to 0 when omitted and is an integer from 0 to 10000
  inclusive; otherwise throw `RangeError`. One basis point is 0.01%.
- Subtotal is the sum of each unit price in cents multiplied by quantity.
  Apply the discount once to the entire subtotal. `discountCents(subtotal,
  couponBps)` in `src/discounts.mjs` returns the discount rounded to the nearest
  cent, with an exact half-cent rounded up. Never round each item's discount.
- `shippingCents(netMerchandiseCents, hasPhysicalItems)` in `src/shipping.mjs`
  returns 0 for carts without physical items. For a physical cart it returns
  0 when **discounted** merchandise is at least 5000 cents, otherwise 499.
- `quoteOrder` returns exactly `{ subtotalCents, discountCents, shippingCents,
  totalCents }`, where total = subtotal - discount + shipping. It must not
  mutate its input. Prices and intermediate totals in valid test cases are
  nonnegative safe integers once expressed in cents.
- The CLI `node src/cli.mjs` reads one complete order JSON from stdin and
  writes exactly one quote JSON object followed by a newline to stdout.
  Invalid input exits nonzero. Keep stdout free of diagnostics.

Examples:

| Order | Subtotal | Discount | Shipping | Total (cents) |
|---|---:|---:|---:|---:|
| 2 physical items at `12.35`, coupon 1000 bps | 2470 | 247 | 499 | 2722 |
| 1 physical item at `50.00`, coupon 1 bps | 5000 | 1 | 499 | 5498 |
| 3 digital items at `0.05`, coupon 1000 bps | 15 | 2 | 0 | 13 |
| Empty cart, no coupon | 0 | 0 | 0 | 0 |

Run the visible smoke tests with `npm test`. They are useful examples, not the
complete acceptance suite.
