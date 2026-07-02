import { z } from "zod";

export const argsSchema = z.object({
  a: z.string().describe("Original / left-hand text"),
  b: z.string().describe("Updated / right-hand text"),
  context: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Lines of unchanged context to keep around each change (default 3)"),
});

const MAX_LINES = 5000;

function lcsOps(a: string[], b: string[]): any[] {
  const n = a.length;
  const m = b.length;
  const dp: any[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: any[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", text: a[i] });
      i++;
    } else {
      ops.push({ type: "ins", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "ins", text: b[j] });
    j++;
  }
  return ops;
}

/** Compare two strings line-by-line and return a unified-diff summary. */
export default async function textDiff(args: any, _ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const ctxLines = parsed.data.context == null ? 3 : parsed.data.context;

  const aLines = parsed.data.a.split("\n");
  const bLines = parsed.data.b.split("\n");
  if (aLines.length > MAX_LINES || bLines.length > MAX_LINES) {
    return { error: "input too large: max " + MAX_LINES + " lines per side" };
  }

  const ops = lcsOps(aLines, bLines);
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.type === "ins") added++;
    else if (op.type === "del") removed++;
    else unchanged++;
  }

  if (added === 0 && removed === 0) {
    return { added, removed, unchanged, identical: true, diff: "" };
  }

  // Keep only context lines around runs of changes.
  const keep: boolean[] = ops.map(() => false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== "eq") {
      for (let w = Math.max(0, k - ctxLines); w <= Math.min(ops.length - 1, k + ctxLines); w++) {
        keep[w] = true;
      }
    }
  }
  const lines: string[] = [];
  let lastKept = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) {
      lastKept = false;
      continue;
    }
    if (!lastKept && lines.length > 0) lines.push("@@");
    const op = ops[k];
    const prefix = op.type === "ins" ? "+" : op.type === "del" ? "-" : " ";
    lines.push(prefix + op.text);
    lastKept = true;
  }

  return { added, removed, unchanged, identical: false, diff: lines.join("\n") };
}
