/** Query results are untyped, so JSON cells render as text rather than a raw object. */
export function formatDebugCell(params: { value: unknown }): string {
  const { value } = params;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
