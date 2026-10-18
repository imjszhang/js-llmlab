import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// The trusted parent requires both successful exit and completion of every assertion.
// Candidate module process.exit(0) cannot count as a completed acceptance run.
async function checkOrderTotal() {
  const { default: assert } = await import("node:assert/strict");
  const { createHash } = await import("node:crypto");
  const { lstatSync, readFileSync, readdirSync } = await import("node:fs");
  const { default: path } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  
  // This checker is injected from the task definition, outside the editable fixture.
  const immutable = {
    "SPEC.md": "9ba2ee54eb0877d10eb63856dc3139b372d7fffc5db96d446d19afb646154bf8",
    "package.json": "67683d3a72a598ffcc34d8c14f21817d4def7f834d33b4e41ec43608755a15c1",
    "test/order.test.mjs": "8dbfb032792dd72a9649eb28849dac9eeb5f57a52b4807067e0dc01c558c25da",
  };
  const editable = ["src/cli.mjs", "src/discounts.mjs", "src/money.mjs", "src/order-service.mjs", "src/shipping.mjs"];
  const expectedFiles = [...Object.keys(immutable), ...editable].sort();
  function listFiles(directory = ".", relative = "") {
    return readdirSync(directory).flatMap((name) => {
      const file = path.join(directory, name);
      const entry = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false, `no symlinks: ${entry}`);
      if (stat.isDirectory()) return listFiles(file, entry);
      assert.equal(stat.isFile(), true, `regular files only: ${entry}`);
      return [entry];
    }).sort();
  }
  assert.deepEqual(listFiles(), expectedFiles, "only the five existing src modules may be edited; do not add files or dependencies");
  for (const [file, hash] of Object.entries(immutable)) {
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), hash, `immutable file changed: ${file}`);
  }
  
  const { toCents } = await import(pathToFileURL(path.resolve("src/money.mjs")));
  const { discountCents } = await import(pathToFileURL(path.resolve("src/discounts.mjs")));
  const { shippingCents } = await import(pathToFileURL(path.resolve("src/shipping.mjs")));
  const { quoteOrder } = await import(pathToFileURL(path.resolve("src/order-service.mjs")));
  for (const [price, expected] of [["0", 0], ["0.01", 1], ["0.1", 10], ["1.15", 115], ["12.35", 1235], ["9999.99", 999999]]) {
    assert.equal(toCents(price), expected, `exact cents for ${price}`);
  }
  for (const price of ["", "01.20", "-1", "1.234", "1.", ".50", "1e2", " 1.00", 1, null]) {
    assert.throws(() => toCents(price), RangeError, `invalid price ${String(price)}`);
  }
  for (const [subtotal, bps, expected] of [[5, 1000, 1], [15, 1000, 2], [5000, 1, 1], [1235, 3333, 412], [0, 10000, 0], [999, 10000, 999]]) {
    assert.equal(discountCents(subtotal, bps), expected, `order discount ${subtotal}/${bps}`);
  }
  for (const [net, physical, expected] of [[4999, true, 499], [5000, true, 0], [0, true, 499], [0, false, 0], [4999, false, 0]]) {
    assert.equal(shippingCents(net, physical), expected, `shipping ${net}/${physical}`);
  }
  
  function expectedQuote(order) {
    const subtotalCents = order.items.reduce((sum, item) => {
      const [whole, fraction = ""] = item.price.split(".");
      return sum + (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) * item.quantity;
    }, 0);
    const bps = order.couponBps ?? 0;
    const discountCents = Number((BigInt(subtotalCents) * BigInt(bps) + 5000n) / 10000n);
    const net = subtotalCents - discountCents;
    const shippingCents = order.items.some((item) => item.physical) && net < 5000 ? 499 : 0;
    return { subtotalCents, discountCents, shippingCents, totalCents: net + shippingCents };
  }
  const orders = [
    { items: [] },
    { items: [{ price: "12.35", quantity: 2, physical: true }], couponBps: 1000 },
    { items: [{ price: "50.00", quantity: 1, physical: true }], couponBps: 1 },
    { items: [{ price: "50.00", quantity: 1, physical: true }] },
    { items: [{ price: "0.05", quantity: 3, physical: false }], couponBps: 1000 },
    { items: [{ price: "0.05", quantity: 1, physical: false }, { price: "0.05", quantity: 1, physical: false }], couponBps: 1000 },
    { items: [{ price: "0", quantity: 1, physical: true }], couponBps: 10000 },
    { items: [{ price: "29.99", quantity: 2, physical: true }, { price: "0.01", quantity: 7, physical: false }], couponBps: 3333 },
  ];
  // Deterministic varied cases prevent matching only the specification examples.
  for (let index = 1; index <= 48; index += 1) {
    orders.push({
      items: Array.from({ length: index % 4 + 1 }, (_, item) => ({
        price: `${(index * 13 + item * 7) % 90}.${String((index * 29 + item * 11) % 100).padStart(2, "0")}`,
        quantity: (index + item * 3) % 9 + 1,
        physical: (index + item) % 3 === 0,
      })),
      couponBps: [0, 1, 500, 1000, 3333, 9999, 10000][index % 7],
    });
  }
  for (const [index, order] of orders.entries()) {
    const original = JSON.stringify(order);
    for (const item of order.items) Object.freeze(item);
    Object.freeze(order.items);
    Object.freeze(order);
    assert.deepEqual(quoteOrder(order), expectedQuote(order), `quote case ${index}`);
    assert.equal(JSON.stringify(order), original, `input unchanged in quote case ${index}`);
  }
  for (const order of [null, {}, { items: null }, { items: [] , couponBps: null }, ...[-1, 10001, 1.5, "100"].map((couponBps) => ({ items: [], couponBps })),
    ...[0, -1, 101, 1.5, "2"].map((quantity) => ({ items: [{ price: "1.00", quantity, physical: true }] })),
    { items: [{ price: "1.00", quantity: 1, physical: "yes" }] }, { items: [null] }]) {
    assert.throws(() => quoteOrder(order), RangeError, `invalid order ${JSON.stringify(order)}`);
  }
  for (const order of [orders[0], orders[1], orders[2], orders[7], orders[31]]) {
    const run = spawnSync(process.execPath, ["src/cli.mjs"], { input: JSON.stringify(order), encoding: "utf8", timeout: 2000 });
    assert.equal(run.error, undefined, "CLI must complete");
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "", "no diagnostics on valid input");
    assert.ok(run.stdout.endsWith("\n"), "CLI output ends with a newline");
    assert.deepEqual(JSON.parse(run.stdout), expectedQuote(order), "CLI emits exactly one quote JSON");
  }
  for (const input of ["{", "{}", JSON.stringify({ items: [{ price: "1.234", quantity: 1, physical: true }] })]) {
    const run = spawnSync(process.execPath, ["src/cli.mjs"], { input, encoding: "utf8", timeout: 2000 });
    assert.equal(run.error, undefined);
    assert.notEqual(run.status, 0, "invalid CLI input must fail");
    assert.equal(run.stdout, "", "diagnostics must not reach stdout");
  }
  console.log(`PASS: immutable files, module boundaries, ${orders.length} quotes, input validation, input immutability and CLI`);
}

const marker = "LLMLAB_ORDER_CHECK_COMPLETE_" + randomBytes(24).toString("hex");
const childSource = '(' + checkOrderTotal.toString() + ')().then(() => { process.stdout.write(' + JSON.stringify(marker + '\n') + '); }, (error) => { console.error(error); process.exitCode = 1; });';
const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
  encoding: "utf8", timeout: 8000, maxBuffer: 1024 * 1024,
});
if (child.stderr) process.stderr.write(child.stderr);
assert.equal(child.error, undefined, "acceptance subprocess must finish");
assert.equal(child.status, 0, "acceptance subprocess must exit successfully");
assert.ok(child.stdout.endsWith(marker + "\n"), "acceptance subprocess must complete every assertion; early exit is not a pass");
process.stdout.write(child.stdout.slice(0, -(marker.length + 1)));
