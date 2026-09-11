/**
 * 字符级相似度，自实现、无依赖、结果确定。
 * 以码点为单位（一个汉字或一个 emoji 算一个字），先统一换行并去掉首尾空白。
 */

function codePoints(text: string): string[] {
  return Array.from(text.replace(/\r\n/gu, "\n").trim());
}

/** 最长公共子序列长度，两行滚动 DP，O(n·m) 时间、O(m) 空间。 */
export function lcsLength(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  let prev = new Uint32Array(right.length + 1);
  let cur = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    const ch = left[i - 1];
    for (let j = 1; j <= right.length; j += 1) {
      if (ch === right[j - 1]) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
      } else {
        const up = prev[j] ?? 0;
        const back = cur[j - 1] ?? 0;
        cur[j] = up > back ? up : back;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return prev[right.length] ?? 0;
}

/** 2·LCS / (|a| + |b|)，0–1。两个都为空算 1。 */
export function similarity(a: string, b: string): number {
  const la = codePoints(a).length;
  const lb = codePoints(b).length;
  if (la + lb === 0) {
    return 1;
  }
  return (2 * lcsLength(a, b)) / (la + lb);
}

/** 候选相对基线改了多少：1 − similarity，0–1。 */
export function changeRatio(candidate: string, baseline: string): number {
  return 1 - similarity(candidate, baseline);
}
