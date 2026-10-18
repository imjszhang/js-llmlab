import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTask } from "../src/lib/bench/config.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = path.join(root, "tasks/fixtures/fix-order-total");
const checker = readFileSync(path.join(root, "tasks/checks/fix-order-total.mjs"), "utf8");

function withWorkspace(run: (workspace: string) => void): void {
  const workspace = mkdtempSync(path.join(tmpdir(), "llmlab-order-task-"));
  try { cpSync(fixture, workspace, { recursive: true }); run(workspace); }
  finally { rmSync(workspace, { recursive: true, force: true }); }
}

function check(workspace: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--input-type=module", "-e", checker], {
    cwd: workspace, encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 10_000,
  });
}

function replaceIn(workspace: string, file: string, before: string, after: string): void {
  const fullPath = path.join(workspace, file);
  const source = readFileSync(fullPath, "utf8");
  assert.ok(source.includes(before), `mutation source exists in ${file}`);
  writeFileSync(fullPath, source.replace(before, after));
}

/** Reference repairs exist only in this offline test; the fixture stays broken. */
function applyReferenceRepair(workspace: string): void {
  replaceIn(workspace, "src/money.mjs", "return Math.trunc(Number(price)) * 100;",
    'const [whole, fraction = ""] = price.split(".");\n  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));');
  replaceIn(workspace, "src/discounts.mjs", "Math.floor(subtotalCents * couponBps / 10000)",
    "Math.floor((subtotalCents * couponBps + 5000) / 10000)");
  replaceIn(workspace, "src/order-service.mjs", "subtotalCents += toCents(item.price);",
    "subtotalCents += toCents(item.price) * item.quantity;");
  replaceIn(workspace, "src/order-service.mjs", "calculateShipping(subtotalCents, hasPhysicalItems)",
    "calculateShipping(subtotalCents - discountCents, hasPhysicalItems)");
}

test("multi-file task embeds the trusted checker exactly and loads with an isolated fixture", () => {
  const task = loadTask(root, "fix-order-total");
  assert.equal(task.fixture, "tasks/fixtures/fix-order-total");
  assert.equal(task.timeoutMs, 300_000);
  assert.deepEqual(task.checks, [{ kind: "command", argv: ["node", "--input-type=module", "-e", checker], timeoutMs: 10_000 }]);
  assert.ok(task.prompt.includes("SPEC.md"));
});

test("multi-file checker rejects the intentionally broken fixture", () => {
  withWorkspace((workspace) => {
    const result = check(workspace);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /exact cents/u);
  });
});

test("multi-file checker accepts a complete reference repair across module boundaries", () => {
  withWorkspace((workspace) => {
    applyReferenceRepair(workspace);
    const result = check(workspace);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /56 quotes/u);
  });
});

for (const mutation of [
  { name: "fractional cents", file: "src/money.mjs", before: 'return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));', after: "return Number(whole) * 100;", message: /exact cents/u },
  { name: "half-cent rounding", file: "src/discounts.mjs", before: "Math.floor((subtotalCents * couponBps + 5000) / 10000)", after: "Math.floor(subtotalCents * couponBps / 10000)", message: /order discount/u },
  { name: "quantity integration", file: "src/order-service.mjs", before: "subtotalCents += toCents(item.price) * item.quantity;", after: "subtotalCents += toCents(item.price);", message: /quote case/u },
  { name: "discounted shipping threshold", file: "src/order-service.mjs", before: "calculateShipping(subtotalCents - discountCents, hasPhysicalItems)", after: "calculateShipping(subtotalCents, hasPhysicalItems)", message: /quote case/u },
]) {
  test(`multi-file checker detects regression in ${mutation.name}`, () => {
    withWorkspace((workspace) => {
      applyReferenceRepair(workspace);
      replaceIn(workspace, mutation.file, mutation.before, mutation.after);
      const result = check(workspace);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(String(result.stderr), mutation.message);
    });
  });
}

for (const file of ["SPEC.md", "package.json", "test/order.test.mjs"]) {
  test(`multi-file checker rejects changing immutable ${file}`, () => {
    withWorkspace((workspace) => {
      applyReferenceRepair(workspace);
      writeFileSync(path.join(workspace, file), `${readFileSync(path.join(workspace, file), "utf8")}\n`);
      const result = check(workspace);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(String(result.stderr), /immutable file changed/u);
    });
  });
}

test("multi-file checker rejects added files and dependency manifests", () => {
  withWorkspace((workspace) => {
    applyReferenceRepair(workspace);
    writeFileSync(path.join(workspace, "package-lock.json"), "{}");
    const result = check(workspace);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /only the five existing src modules/u);
  });
});

test("multi-file checker exercises the CLI independently of module exports", () => {
  withWorkspace((workspace) => {
    applyReferenceRepair(workspace);
    writeFileSync(path.join(workspace, "src/cli.mjs"), 'console.log("{}");\n');
    const result = check(workspace);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /CLI emits exactly one quote/u);
  });
});

test("multi-file checker rejects a candidate module exiting zero before assertions complete", () => {
  withWorkspace((workspace) => {
    applyReferenceRepair(workspace);
    writeFileSync(path.join(workspace, "src/money.mjs"), "process.exit(0);\n");
    const result = check(workspace);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /early exit is not a pass/u);
  });
});
