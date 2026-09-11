export const DEFAULT_CONCURRENCY = 3;

/** `--concurrency <n>`：必须是 ≥ 1 的整数；缺省 3。 */
export function parseConcurrency(value: string | undefined, fallback = DEFAULT_CONCURRENCY): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--concurrency 需要 ≥ 1 的整数，收到 ${value}`);
  }
  return n;
}

/**
 * 有限并发地跑一组任务，结果按输入顺序返回，与完成顺序无关。
 * 单个任务的异常直接抛出（调用方应在 fn 内自行吞掉可恢复的错误）。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
