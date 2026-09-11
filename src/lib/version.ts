import { readFileSync } from "node:fs";

/** 版本号只在 package.json 维护一处；`--version` 从这里读，不再手写。 */
export function readPackageVersion(): string {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (typeof raw === "object" && raw !== null && typeof (raw as { version?: unknown }).version === "string") {
    return (raw as { version: string }).version;
  }
  return "0.0.0";
}
