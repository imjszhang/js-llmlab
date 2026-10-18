# Order normalization

Specification date: 2026-10-17. Use Node.js built-ins only.

Create a reusable `build-report.mjs` in this directory. Running `node build-report.mjs`
from any workspace containing this fixture must read `inputs/orders.csv` and
`inputs/customers.json`, create `outputs/`, and write the three JSON files below.
Run it yourself before finishing. Do not modify the input files or this specification.
The generator must compute results from its current inputs; it will also be tested
with other data following these rules. Do not hard-code order IDs, totals or mappings.

## Inputs and processing order

- CSV header is exactly `order_id,customer_id,status,quantity,unit_price,currency,updated_at,note`.
  Fields may be quoted; quoted fields can contain commas and doubled double quotes.
  Line endings can be LF or CRLF. A final newline is optional. Fields do not contain
  embedded line breaks. Ignore a completely empty trailing record. Unicode is UTF-8.
- Trim surrounding whitespace from every CSV field. `order_id` and `customer_id`
  are case-sensitive nonempty identifiers. Normalize status and currency to uppercase.
  `note` is unused. All records have the stated number of fields.
- First deduplicate by trimmed `order_id`: keep the row with lexicographically greatest
  `updated_at`; on equal timestamps keep the later row in the CSV. Timestamps are all
  valid fixed-width UTC `YYYY-MM-DDTHH:mm:ssZ`, so string order is time order.
  Deduplicate before validation. A discarded duplicate is neither accepted nor rejected.
- Validate each winning row in this exact priority order, recording only the first error:
  1. `status`: status is neither `PAID` nor `SHIPPED`.
  2. `currency`: currency is not `CNY`.
  3. `unknown-customer`: customer ID is absent from `customers.json`.
  4. `invalid-quantity`: quantity does not match `^[1-9][0-9]*$` or its numeric value
     exceeds 1000. Zero, decimals, signs and leading zeroes are invalid.
  5. `invalid-price`: unit price does not match `^[0-9]+(?:\.[0-9]{1,2})?$` or exceeds
     99999.99. Zero and leading zeroes are valid. Signs, exponent syntax, missing
     integer parts, trailing decimal points and more than two decimal places are invalid.
- Convert unit price to integer cents using its decimal digits (pad one fractional
  digit with a trailing zero). Multiply cents by quantity for `total_cents`. All money
  and quantities in outputs must be JSON integers; never round binary float products.
- `customers.json` is an object from customer ID to `{ "name": string, "region": string }`.
  Copy mapped names and regions exactly, including Unicode, punctuation and whitespace.
  Mapping keys need no normalization. All mapped customers have both fields.

## Outputs

Every object must have exactly the listed keys; JSON object key order and indentation
are not significant. Sort arrays by the stated string fields using JavaScript's code
unit ordering (`a < b`), not locale collation. Do not include extra metadata or timestamps.
Write JSON in UTF-8. Empty input (header only) is valid and gives empty arrays and zeroes.

`outputs/orders.json`:

```json
{
  "schema_version": 1,
  "orders": [
    {
      "order_id": "example",
      "customer_id": "C001",
      "customer_name": "Lena, Wu",
      "region": "华东",
      "status": "PAID",
      "currency": "CNY",
      "quantity": 2,
      "unit_price_cents": 125,
      "total_cents": 250
    }
  ]
}
```

`orders` contains only accepted winners, ascending by `order_id`.

`outputs/rejected.json`:

```json
{ "schema_version": 1, "rejected": [{ "order_id": "example", "reason": "status" }] }
```

`rejected` contains only rejected winners, ascending by `order_id`.

`outputs/summary.json`:

```json
{
  "schema_version": 1,
  "input_rows": 0,
  "unique_orders": 0,
  "duplicate_rows": 0,
  "accepted_orders": 0,
  "rejected_orders": 0,
  "quantity": 0,
  "total_cents": 0,
  "regions": [{ "region": "example", "order_count": 0, "quantity": 0, "total_cents": 0 }],
  "rejection_counts": {
    "status": 0,
    "currency": 0,
    "unknown-customer": 0,
    "invalid-quantity": 0,
    "invalid-price": 0
  }
}
```

`input_rows` counts data records before deduplication; `unique_orders` counts winners;
`duplicate_rows = input_rows - unique_orders`. `quantity`, `total_cents` and each
region's counts/totals include only accepted orders. `regions` contains only regions
with at least one accepted order, ascending by `region`. Always include all five
`rejection_counts` keys, even when zero. Re-running must replace all three outputs.
