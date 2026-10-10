export const DEFAULT_QUICKJS_POOL_SIZE = 4;
export const MAX_QUICKJS_POOL_SIZE = 32;

/** Shared by config writes and the executor's deployment-env check. */
export function validateQuickJSPoolSize(value: unknown): string | null {
  const error = `Invalid SCRIPT_QUICKJS_POOL_SIZE (must be an integer between 1 and ${MAX_QUICKJS_POOL_SIZE})`;
  if (typeof value !== "string" && typeof value !== "number") return error;
  const text = String(value).trim();
  const size = Number(text);
  if (
    !/^\d+$/.test(text) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_QUICKJS_POOL_SIZE
  ) {
    return error;
  }
  return null;
}

export function resolveQuickJSPoolSize(value: string | undefined): number {
  if (value === undefined) return DEFAULT_QUICKJS_POOL_SIZE;
  const error = validateQuickJSPoolSize(value);
  if (error) throw new Error(error);
  return Number(value);
}
