import { loadEnv } from "../lib/config.ts";
import { findProjectRoot } from "../lib/paths.ts";
import { LabStore } from "../lib/store.ts";
import { forkBranch } from "../lib/tree.ts";

export function runBranchLs(sessionId: string): void {
  const root = findProjectRoot();
  loadEnv(root);
  const store = new LabStore(root);
  const branches = store.listBranches(sessionId);
  if (branches.length === 0) {
    console.log("没有分支。");
    return;
  }
  for (const branch of branches) {
    console.log(`${branch.name}  head=${branch.head ?? "(empty)"}  from=${branch.createdFrom ?? "null"}`);
  }
}

export function runBranchCreate(options: {
  session: string;
  name: string;
  from?: string;
}): void {
  const root = findProjectRoot();
  loadEnv(root);
  const store = new LabStore(root);
  store.getSession(options.session);
  const fromNodeId = options.from ?? store.getBranch(options.session, "main").head;
  const branch = forkBranch(store, options.session, options.name, fromNodeId);
  console.log(`已创建分支 ${branch.name}  head=${branch.head ?? "(empty)"}`);
}
