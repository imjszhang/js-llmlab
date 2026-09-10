import { randomBytes } from "node:crypto";

export type IdPrefix = "s" | "n" | "c";

export function createId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(5).toString("hex")}`;
}
