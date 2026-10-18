export function toCents(price) {
  if (typeof price !== "string" || !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(price)) {
    throw new RangeError("price must be a nonnegative decimal string");
  }
  return Math.trunc(Number(price)) * 100;
}
