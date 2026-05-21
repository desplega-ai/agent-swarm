import { z } from "zod";

export const argsSchema = z.object({
  items: z.array(z.unknown()).describe("Array of objects to aggregate"),
  by: z.string().describe("Field name (dotted paths allowed) to group by"),
  sum: z
    .string()
    .optional()
    .describe("Optional numeric field name to sum within each group"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Return only the top N groups by count (default: all)"),
});

function dig(obj: any, path: string): any {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function keyOf(value: any): string {
  if (value === undefined) return "(undefined)";
  if (value === null) return "(null)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Group an array of objects by a field, returning per-group count and optional sum. */
export default async function groupCount(args: any, _ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { items, by } = parsed.data;
  const sumField = parsed.data.sum;

  const groups: any = {};
  let totalSum = 0;
  for (const item of items) {
    const key = keyOf(dig(item, by));
    if (!groups[key]) groups[key] = { key, count: 0, sum: 0 };
    groups[key].count++;
    if (sumField) {
      const raw = dig(item, sumField);
      const num = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isNaN(num)) {
        groups[key].sum += num;
        totalSum += num;
      }
    }
  }

  let rows: any[] = Object.keys(groups).map((k: string) => {
    const g = groups[k];
    return sumField ? { key: g.key, count: g.count, sum: g.sum } : { key: g.key, count: g.count };
  });
  rows.sort((a: any, b: any) => b.count - a.count);
  if (parsed.data.limit) rows = rows.slice(0, parsed.data.limit);

  return {
    groups: rows,
    groupCount: rows.length,
    total: items.length,
    totalSum: sumField ? totalSum : undefined,
  };
}
