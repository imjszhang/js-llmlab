import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GOLDEN_DIR = fileURLToPath(new URL("./golden/", import.meta.url));

/**
 * 渲染结果与 `tests/golden/<name>` 逐字节比对。
 * 改了渲染格式且确认是预期变化时，用 `UPDATE_GOLDEN=1 npm test` 重新生成，再人工 review diff。
 */
export function assertMatchesGolden(name: string, actual: string, dir = GOLDEN_DIR): void {
  const filePath = path.join(dir, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, actual, "utf8");
    return;
  }
  if (!existsSync(filePath)) {
    throw new Error(`缺少黄金文件 ${filePath}；用 UPDATE_GOLDEN=1 npm test 生成`);
  }
  const expected = readFileSync(filePath, "utf8");
  assert.equal(
    actual,
    expected,
    `${name} 与黄金文件不一致。确认是预期变化后：UPDATE_GOLDEN=1 npm test，然后 review diff`,
  );
}
