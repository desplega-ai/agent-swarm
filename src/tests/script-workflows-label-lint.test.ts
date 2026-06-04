import { describe, expect, test } from "bun:test";
import { lintWorkflowLabels } from "../script-workflows/label-lint";

describe("lintWorkflowLabels", () => {
  test("rejects a literal step label inside a loop", () => {
    const result = lintWorkflowLabels(`
      export default async function main(args, ctx) {
        for (const item of args.items) {
          await ctx.step.agentTask("process", { task: item.task });
        }
      }
    `);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.label).toBe("process");
      expect(result.errors[0]?.detail).toContain("inside a loop");
    }
  });

  test("allows template literal step labels inside a loop", () => {
    const result = lintWorkflowLabels(`
      export default async function main(args, ctx) {
        for (const item of args.items) {
          await ctx.step.agentTask(\`process:\${item.id}\`, { task: item.task });
        }
      }
    `);

    expect(result).toEqual({ ok: true });
  });

  test("allows literal step labels outside loops", () => {
    const result = lintWorkflowLabels(`
      export default async function main(_args, ctx) {
        await ctx.step.rawLlm("summarize", { prompt: "hello" });
      }
    `);

    expect(result).toEqual({ ok: true });
  });
});
