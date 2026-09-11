/**
 * 把一次真实对比导出成测试 fixture：
 *
 *   npx tsx scripts/export-fixture.ts <c_id> <fixture-name>
 *
 * 产物：tests/fixtures/<fixture-name>/comparison.json = { spec, variants }。
 * 写出前做脱敏检查：不允许出现 sk-、Bearer，也不允许出现 .env 里任何变量的值。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { findProjectRoot } from "../src/lib/paths.ts";
import { LabStore } from "../src/lib/store.ts";

function secretsFromDotenv(root: string): string[] {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) {
    return [];
  }
  const parsed = parseDotenv(readFileSync(envPath, "utf8"));
  return Object.values(parsed).filter((value) => value.length >= 8);
}

function main(): void {
  const [comparisonId, fixtureName] = process.argv.slice(2);
  if (comparisonId === undefined || fixtureName === undefined) {
    console.error("用法：npx tsx scripts/export-fixture.ts <c_id> <fixture-name>");
    process.exit(2);
  }
  const root = findProjectRoot();
  const store = new LabStore(root);
  const { spec, variants } = store.readComparison(comparisonId);
  const json = `${JSON.stringify({ spec, variants }, null, 2)}\n`;

  if (/sk-[A-Za-z0-9]/u.test(json) || /Bearer\s/u.test(json)) {
    throw new Error("fixture 内容疑似含密钥（sk- / Bearer），拒绝写出");
  }
  for (const secret of secretsFromDotenv(root)) {
    if (json.includes(secret)) {
      throw new Error("fixture 内容包含 .env 中某个变量的值，拒绝写出");
    }
  }

  const outDir = path.join(root, "tests", "fixtures", fixtureName);
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "comparison.json");
  writeFileSync(outPath, json, "utf8");
  console.log(`已写入 ${path.relative(root, outPath)}（${String(variants.length)} 路）`);
}

main();
