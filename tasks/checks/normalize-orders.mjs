import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workspace = process.cwd();
const expectedHashes = {
  'SPEC.md': '4a5b3c4b531cdae70d126a4904635af0b38fd6842d85e17ed9fda1a92f7903ee',
  'inputs/customers.json': 'ff586959d5bf216402d3a6b80e0b178ae789a4420f18640fff97f6d65a949dd6',
  'inputs/orders.csv': 'bc46743c3430481da4606b2bd0295693b7ed353c1ef7abb9d3f541c34fe49242',
};
function digest(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
for (const [file, expected] of Object.entries(expectedHashes)) {
  assert.equal(digest(path.join(workspace, file)), expected, `Immutable input changed: ${file}`);
}
assert.ok(lstatSync(path.join(workspace, 'build-report.mjs')).isFile(), 'Missing regular build-report.mjs');

function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') { row.push(field); field = ''; }
    else if (!quoted && (ch === '\r' || ch === '\n')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  assert.equal(quoted, false, 'Unclosed CSV quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows.at(-1).length === 1 && rows.at(-1)[0] === '') rows.pop();
  return rows;
}
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function expected(csv, customers) {
  const rows = csvRows(csv);
  const header = rows.shift();
  assert.deepEqual(header, ['order_id', 'customer_id', 'status', 'quantity', 'unit_price', 'currency', 'updated_at', 'note']);
  const winners = new Map();
  for (const source of rows) {
    assert.equal(source.length, 8);
    const row = Object.fromEntries(header.map((key, index) => [key, source[index].trim()]));
    row.status = row.status.toUpperCase(); row.currency = row.currency.toUpperCase();
    if (!winners.has(row.order_id) || row.updated_at >= winners.get(row.order_id).updated_at) winners.set(row.order_id, row);
  }
  const orders = [], rejected = [], regionMap = new Map();
  const rejection_counts = { status: 0, currency: 0, 'unknown-customer': 0, 'invalid-quantity': 0, 'invalid-price': 0 };
  for (const row of [...winners.values()].sort((a, b) => compare(a.order_id, b.order_id))) {
    const customer = Object.hasOwn(customers, row.customer_id) ? customers[row.customer_id] : null;
    const parts = row.unit_price.split('.');
    const cents = Number(parts[0]) * 100 + Number((parts[1] ?? '').padEnd(2, '0'));
    const reason = !['PAID', 'SHIPPED'].includes(row.status) ? 'status'
      : row.currency !== 'CNY' ? 'currency'
      : !customer ? 'unknown-customer'
      : !/^[1-9][0-9]*$/.test(row.quantity) || Number(row.quantity) > 1000 ? 'invalid-quantity'
      : !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(row.unit_price) || cents > 9999999 ? 'invalid-price' : null;
    if (reason) { rejected.push({ order_id: row.order_id, reason }); rejection_counts[reason]++; continue; }
    const quantity = Number(row.quantity), total = quantity * cents;
    orders.push({ order_id: row.order_id, customer_id: row.customer_id, customer_name: customer.name, region: customer.region,
      status: row.status, currency: 'CNY', quantity, unit_price_cents: cents, total_cents: total });
    if (!regionMap.has(customer.region)) regionMap.set(customer.region, { region: customer.region, order_count: 0, quantity: 0, total_cents: 0 });
    const region = regionMap.get(customer.region);
    region.order_count++; region.quantity += quantity; region.total_cents += total;
  }
  return {
    'orders.json': { schema_version: 1, orders },
    'rejected.json': { schema_version: 1, rejected },
    'summary.json': { schema_version: 1, input_rows: rows.length, unique_orders: winners.size, duplicate_rows: rows.length - winners.size,
      accepted_orders: orders.length, rejected_orders: rejected.length,
      quantity: orders.reduce((sum, row) => sum + row.quantity, 0), total_cents: orders.reduce((sum, row) => sum + row.total_cents, 0),
      regions: [...regionMap.values()].sort((a, b) => compare(a.region, b.region)), rejection_counts },
  };
}
function verify(dir, data, label) {
  for (const [name, wanted] of Object.entries(data)) {
    const file = path.join(dir, 'outputs', name);
    assert.ok(existsSync(file) && lstatSync(file).isFile(), `${label}: missing regular outputs/${name}`);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), wanted, `${label}: outputs/${name}`);
  }
}
const csv = readFileSync(path.join(workspace, 'inputs/orders.csv'), 'utf8');
const customers = JSON.parse(readFileSync(path.join(workspace, 'inputs/customers.json'), 'utf8'));
const publicExpected = expected(csv, customers);
verify(workspace, publicExpected, 'public fixture');

const header = 'order_id,customer_id,status,quantity,unit_price,currency,updated_at,note';
const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
const encode = (rows, eol = '\n') => header + eol + rows.map((row) => row.map(quote).join(',')).join(eol);
const variants = [
  {
    csv: encode([
      ['Z-9', 'hidden', ' PAID ', '3', '0.29', 'cny', '2026-01-02T03:04:05Z', 'a,b "quoted"'],
      ['a-1', 'second', 'shipped', '1000', '0.01', 'CNY', '2026-01-03T03:04:05Z', ''],
      ['Z-9', 'hidden', 'PAID', '2', '100.00', 'CNY', '2026-01-01T03:04:05Z', 'older later'],
      ['TIE', 'hidden', 'CANCELLED', '1', '1', 'CNY', '2026-01-03T03:04:05Z', 'first tie'],
      [' TIE ', 'second', 'PAID', '2', '0002.5', 'CNY', '2026-01-03T03:04:05Z', 'later tie'],
      ['BAD-A', 'absent', 'pending', 'bad', 'bad', 'USD', '2026-01-03T03:04:05Z', ''],
      ['BAD-B', 'absent', 'PAID', 'bad', 'bad', 'USD', '2026-01-03T03:04:05Z', ''],
      ['BAD-C', 'absent', 'PAID', 'bad', 'bad', 'CNY', '2026-01-03T03:04:05Z', ''],
      ['BAD-D', 'hidden', 'PAID', '01', 'bad', 'CNY', '2026-01-03T03:04:05Z', ''],
      ['BAD-E', 'hidden', 'PAID', '1', '1e2', 'CNY', '2026-01-03T03:04:05Z', ''],
    ], '\r\n'),
    customers: { hidden: { name: 'Élodie, "林"', region: 'a-region' }, second: { name: 'New Customer', region: 'Z-region' } },
  },
  {
    csv: encode([
      ['case-7', 'N', 'SHIPPED', '2', '99999.99', 'CNY', '2026-02-01T00:00:00Z', ''],
      ['case-2', 'N', 'PAID', '7', '0', 'CNY', '2026-02-01T00:00:00Z', ''],
      ['case-3', 'N', 'PAID', '1', '.50', 'CNY', '2026-02-01T00:00:00Z', ''],
      ['case-4', 'N', 'PAID', '+1', '3', 'CNY', '2026-02-01T00:00:00Z', ''],
      ['case-5', 'N', 'PAID', '1', '100000', 'CNY', '2026-02-01T00:00:00Z', ''],
      ['case-6', 'N', 'PAID', '1', '3.', 'CNY', '2026-02-01T00:00:00Z', ''],
    ]), customers: { N: { name: '  Preserve mapping spaces  ', region: '区域 🧪' } },
  },
  { csv: header + '\r\n', customers: {} },
];

// A frozen trusted checker replays the candidate generator with new inputs outside
// the agent workspace. No candidate-supplied test script determines correctness.
const temp = mkdtempSync(path.join(tmpdir(), 'llmlab-orders-check-'));
try {
  const run = path.join(temp, 'reused-workspace');
  cpSync(workspace, run, { recursive: true, filter: (source) => {
    const relative = path.relative(workspace, source).split(path.sep)[0];
    return !['inputs', 'outputs', '.git', 'node_modules'].includes(relative);
  } });
  mkdirSync(path.join(run, 'inputs'), { recursive: true });
  for (const [index, variant] of [{ csv, customers }, ...variants].entries()) {
    // Keep earlier outputs: every rerun must overwrite stale reports.

    writeFileSync(path.join(run, 'inputs/orders.csv'), variant.csv);
    writeFileSync(path.join(run, 'inputs/customers.json'), JSON.stringify(variant.customers));
    const before = ['orders.csv', 'customers.json'].map((file) => digest(path.join(run, 'inputs', file)));
    const child = spawnSync(process.execPath, ['build-report.mjs'], { cwd: run, encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? '' } });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `replay ${index}: generator failed: ${child.stderr}`);
    verify(run, expected(variant.csv, variant.customers), `replay ${index}`);
    assert.deepEqual(['orders.csv', 'customers.json'].map((file) => digest(path.join(run, 'inputs', file))), before, 'Generator modified replay inputs');
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`Passed order normalization: ${publicExpected['summary.json'].accepted_orders} accepted, ${publicExpected['summary.json'].rejected_orders} rejected; four generator replays passed.`);
