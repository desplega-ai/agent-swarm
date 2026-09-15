export function block(reason: string): { action: "block"; reason: string } {
  return { action: "block", reason };
}

export function modify<T>(data: T): { action: "modify"; data: T } {
  return { action: "modify", data };
}
