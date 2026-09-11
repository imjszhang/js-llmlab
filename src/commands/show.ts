import chalk from "chalk";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEnv } from "../lib/config.ts";
import { sessionDir } from "../lib/paths.ts";
import { renderComparisonList, renderSummaryTable, renderTurn } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";
import { resolveDeps, type CommandDeps } from "./deps.ts";

/** `compare ls`：按 createdAt 倒序列出所有对比；坏目录打警告到 stderr，不中断。 */
export function runCompareLs(deps?: CommandDeps): void {
  const { root, log, error } = resolveDeps(deps);
  loadEnv(root);
  const store = new LabStore(root);
  const { entries, warnings } = store.listComparisons();
  for (const warning of warnings) {
    error(chalk.yellow(warning));
  }
  if (entries.length === 0) {
    log("还没有对比。跑一次 compare 后再来：js-llmlab compare --suite deepseek --message '...'");
    return;
  }
  log(renderComparisonList(entries));
}

/** `compare show <c_id>`：打印与 report.md 完全相同的汇总表（同一渲染函数）与目录。 */
export function runCompareShow(comparisonId: string, deps?: CommandDeps): void {
  const { root, log } = resolveDeps(deps);
  loadEnv(root);
  const store = new LabStore(root);
  const { spec, variants, dir } = store.readComparison(comparisonId);
  const scores = store.readScores(comparisonId);
  log(chalk.bold(`comparison ${spec.id}`));
  log(chalk.dim(`createdAt ${spec.createdAt}  session ${spec.sessionId ?? "null"}  from ${spec.fromNodeId ?? "null"}${spec.repeat !== undefined ? `  repeat ${String(spec.repeat)}` : ""}`));
  log("");
  log(renderSummaryTable(variants, scores));
  log("");
  log(chalk.dim(`目录 ${dir}`));
}

export type NodeShowOptions = {
  /** 打原始节点 JSON 而不是 turn md。 */
  json?: boolean;
};

/** `node show <session> <node> [--json]`：打印 turn md（有文件读文件，否则现渲染）或节点 JSON。 */
export function runNodeShow(sessionId: string, nodeId: string, options: NodeShowOptions = {}, deps?: CommandDeps): void {
  const { root, log } = resolveDeps(deps);
  loadEnv(root);
  const store = new LabStore(root);
  const node = store.getNode(sessionId, nodeId);
  if (options.json === true) {
    log(JSON.stringify(node, null, 2));
    return;
  }
  const turnPath = path.join(sessionDir(root, sessionId), "turns", `${nodeId}.md`);
  log(existsSync(turnPath) ? readFileSync(turnPath, "utf8").replace(/\n$/u, "") : renderTurn(node).replace(/\n$/u, ""));
}
