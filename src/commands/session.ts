import chalk from "chalk";
import { loadEnv } from "../lib/config.ts";
import { findProjectRoot } from "../lib/paths.ts";
import { renderSessionSummary, renderTree } from "../lib/render.ts";
import { LabStore } from "../lib/store.ts";

export function runSessionLs(): void {
  const root = findProjectRoot();
  loadEnv(root);
  const store = new LabStore(root);
  const sessions = store.listSessions();
  if (sessions.length === 0) {
    console.log("还没有会话。用 js-llmlab chat 或 run 创建。");
    return;
  }
  for (const session of sessions) {
    console.log(
      `${session.id}  ${session.updatedAt}  ${session.defaultConfig}  ${session.title}`,
    );
  }
}

export function runSessionShow(sessionId: string): void {
  const root = findProjectRoot();
  loadEnv(root);
  const store = new LabStore(root);
  const session = store.getSession(sessionId);
  console.log(chalk.bold(`session ${session.id}`));
  console.log(
    renderSessionSummary(
      session.title,
      session.createdAt,
      session.updatedAt,
      session.defaultConfig,
      session.defaultSystem,
    ),
  );
  console.log("");
  console.log(renderTree(store.listNodes(sessionId), store.listBranches(sessionId)));
}
