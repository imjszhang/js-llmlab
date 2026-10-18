import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTask } from "../src/lib/bench/config.ts";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "tasks/fixtures/normalize-orders");
const checker = readFileSync(path.join(root, "tasks/checks/normalize-orders.mjs"), "utf8");

// An independent small implementation is test-only: the task fixture contains
// no solution or expected report, and candidate checks never import this source.
const reference = String.raw`
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const records = readFileSync('inputs/orders.csv', 'utf8').trimEnd().split(/\r?\n/).slice(1).map(line => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(field => {
  const decoded = field.startsWith('"') && field.endsWith('"') ? field.slice(1, -1).replaceAll('""', '"') : field;
  return decoded.trim();
}));
const customers = JSON.parse(readFileSync('inputs/customers.json', 'utf8'));
const byId = {};
for (const r of records) if (!byId[r[0]] || r[6] >= byId[r[0]][6]) byId[r[0]] = r;
const orders = [], rejected = [], regionTotals = {};
const counts = { status: 0, currency: 0, 'unknown-customer': 0, 'invalid-quantity': 0, 'invalid-price': 0 };
for (const id of Object.keys(byId).sort()) {
  const [order_id, customer_id, rawStatus, rawQuantity, price, rawCurrency] = byId[id];
  const status = rawStatus.toUpperCase(), currency = rawCurrency.toUpperCase(), quantity = Number(rawQuantity);
  const money = price.split('.');
  const cents = Number(money[0]) * 100 + Number((money[1] ?? '').padEnd(2, '0'));
  let reason = null;
  if (status !== 'PAID' && status !== 'SHIPPED') reason = 'status';
  else if (currency !== 'CNY') reason = 'currency';
  else if (!Object.hasOwn(customers, customer_id)) reason = 'unknown-customer';
  else if (!/^[1-9][0-9]*$/.test(rawQuantity) || quantity > 1000) reason = 'invalid-quantity';
  else if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(price) || cents > 9999999) reason = 'invalid-price';
  if (reason) { rejected.push({ order_id, reason }); counts[reason]++; continue; }
  const { name: customer_name, region } = customers[customer_id];
  const total_cents = quantity * cents;
  orders.push({ order_id, customer_id, customer_name, region, status, currency, quantity, unit_price_cents: cents, total_cents });
  regionTotals[region] ??= { region, order_count: 0, quantity: 0, total_cents: 0 };
  regionTotals[region].order_count++; regionTotals[region].quantity += quantity; regionTotals[region].total_cents += total_cents;
}
const summary = { schema_version: 1, input_rows: records.length, unique_orders: Object.keys(byId).length,
  duplicate_rows: records.length - Object.keys(byId).length, accepted_orders: orders.length, rejected_orders: rejected.length,
  quantity: orders.reduce((sum, r) => sum + r.quantity, 0), total_cents: orders.reduce((sum, r) => sum + r.total_cents, 0),
  regions: Object.keys(regionTotals).sort().map(key => regionTotals[key]), rejection_counts: counts };
mkdirSync('outputs', { recursive: true });
for (const [file, value] of Object.entries({ orders: { schema_version: 1, orders }, rejected: { schema_version: 1, rejected }, summary })) {
  writeFileSync('outputs/' + file + '.json', JSON.stringify(value));
}
`;

function makeWorkspace(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "llmlab-data-task-"));
  cpSync(fixture, workspace, { recursive: true });
  return workspace;
}
function execute(source: string, workspace: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: workspace, encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH ?? "" }, maxBuffer: 1024 * 1024,
  });
}
function writeReference(workspace: string): void {
  writeFileSync(path.join(workspace, "build-report.mjs"), reference);
  const built = execute(reference, workspace);
  assert.ifError(built.error);
  assert.equal(built.status, 0, built.stderr);
}

test("normalize-orders task embeds exactly the trusted checker and uses frozen isolated inputs", () => {
  const task = loadTask(root, "normalize-orders");
  assert.equal(task.timeoutMs, 300000);
  assert.equal(task.fixture, "tasks/fixtures/normalize-orders");
  const check = task.checks.find((item) => item.kind === "command");
  assert.ok(check?.kind === "command");
  assert.deepEqual(check.argv, ["node", "--input-type=module", "-e", checker]);
  assert.equal(check.timeoutMs, 10000);
  const csv = readFileSync(path.join(fixture, "inputs/orders.csv"), "utf8");
  assert.ok(csv.includes("\r\n"));
  assert.ok(csv.includes('"上海, rush"'));
  assert.ok(csv.includes('"客户说 ""谢谢"""'));
});

test("normalize-orders checker fails before any artifacts exist", () => {
  const workspace = makeWorkspace();
  try {
    const checked = execute(checker, workspace);
    assert.ifError(checked.error);
    assert.notEqual(checked.status, 0);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("normalize-orders independent solution passes public totals and four generator replays", () => {
  const workspace = makeWorkspace();
  try {
    writeReference(workspace);
    const summary: unknown = JSON.parse(readFileSync(path.join(workspace, "outputs/summary.json"), "utf8"));
    assert.deepEqual(summary, {
      schema_version: 1, input_rows: 27, unique_orders: 21, duplicate_rows: 6,
      accepted_orders: 12, rejected_orders: 9, quantity: 33, total_cents: 10039747,
      regions: [
        { region: "华东", order_count: 5, quantity: 14, total_cents: 36493 },
        { region: "华北", order_count: 1, quantity: 1, total_cents: 9999999 },
        { region: "华南", order_count: 3, quantity: 5, total_cents: 520 },
        { region: "西部", order_count: 3, quantity: 13, total_cents: 2735 },
      ],
      rejection_counts: { status: 2, currency: 1, "unknown-customer": 1, "invalid-quantity": 2, "invalid-price": 3 },
    });
    const checked = execute(checker, workspace);
    assert.ifError(checked.error);
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /four generator replays passed/);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("normalize-orders checker rejects incorrect numbers, hard-coded reports and modified inputs", () => {
  for (const mistake of ["wrong-total", "hard-coded", "skip-overwrite", "changed-input"] as const) {
    const workspace = makeWorkspace();
    try {
      writeReference(workspace);
      if (mistake === "wrong-total") {
        const file = path.join(workspace, "outputs/summary.json");
        writeFileSync(file, readFileSync(file, "utf8").replace('"total_cents":10039747', '"total_cents":10039748'));
      } else if (mistake === "hard-coded") {
        const hardCoded = Object.fromEntries(["orders", "rejected", "summary"].map((name) => [name, readFileSync(path.join(workspace, `outputs/${name}.json`), "utf8")]));
        writeFileSync(path.join(workspace, "build-report.mjs"), `import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('outputs', { recursive: true }); for (const [name, contents] of Object.entries(${JSON.stringify(hardCoded)})) writeFileSync('outputs/' + name + '.json', contents);`);
      } else if (mistake === "skip-overwrite") {
        writeFileSync(path.join(workspace, "build-report.mjs"), `import { existsSync } from 'node:fs'; if (existsSync('outputs/summary.json')) process.exit(0); ${reference}`);
      } else {
        const file = path.join(workspace, "inputs/orders.csv");
        writeFileSync(file, readFileSync(file, "utf8") + "\r\n");
      }
      const checked = execute(checker, workspace);
      assert.ifError(checked.error);
      assert.notEqual(checked.status, 0, mistake);
      assert.match(checked.stderr, mistake === "wrong-total" ? /summary\.json/ : (mistake === "hard-coded" || mistake === "skip-overwrite") ? /replay 1/ : /Immutable input changed/);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
});
