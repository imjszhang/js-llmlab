import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseComparisonSpec, parseComparisonVariant } from "../src/lib/parse.ts";
import type { ComparisonSpec, ComparisonVariant } from "../src/types.ts";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

export type ComparisonFixture = {
  spec: ComparisonSpec;
  variants: ComparisonVariant[];
};

/** 读 `tests/fixtures/<name>/comparison.json`（由 scripts/export-fixture.ts 生成）。 */
export function loadComparisonFixture(name: string): ComparisonFixture {
  const filePath = path.join(FIXTURES_DIR, name, "comparison.json");
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.variants)) {
    throw new Error(`fixture ${name} 需要 { spec, variants[] }`);
  }
  return {
    spec: parseComparisonSpec(raw.spec),
    variants: raw.variants.map((item) => parseComparisonVariant(item)),
  };
}

export function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}
