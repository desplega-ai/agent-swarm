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

  test("rejects a single-quoted step label inside a loop", () => {
    const result = lintWorkflowLabels(`
      export default async function main(args, ctx) {
        for (const item of args.items) {
          await ctx.step.agentTask('process', { task: item.task });
        }
      }
    `);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.label).toBe("process");
    }
  });

  test("rejects a template literal without interpolation inside a loop", () => {
    const result = lintWorkflowLabels(`
      export default async function main(args, ctx) {
        for (const item of args.items) {
          await ctx.step.agentTask(\`process\`, { task: item.task });
        }
      }
    `);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.label).toBe("process");
      expect(result.errors[0]?.detail).toContain("actual interpolation");
    }
  });

  test("rejects a literal step label more than ten lines into a loop", () => {
    const result = lintWorkflowLabels(`
      export default async function main(args, ctx) {
        for (const item of args.items) {
          const one = item.one;
          const two = item.two;
          const three = item.three;
          const four = item.four;
          const five = item.five;
          const six = item.six;
          const seven = item.seven;
          const eight = item.eight;
          const nine = item.nine;
          const ten = item.ten;
          const eleven = item.eleven;
          await ctx.step.agentTask("process", { task: item.task });
        }
      }
    `);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.label).toBe("process");
    }
  });

  test("allows the Promise.all fan-out idiom — derived labels inside .map() are not literal", () => {
    const result = lintWorkflowLabels(`
      export default async function main(args, ctx) {
        return Promise.all(
          args.items.map((item, i) => ctx.step.agentTask(\`phase-\${i}\`, { task: item.task }))
        );
      }
    `);

    expect(result).toEqual({ ok: true });
  });

  test("allows a literal fan-in label after a closed .map()", () => {
    const result = lintWorkflowLabels(`
      export default async function main(args, ctx) {
        const results = await Promise.all(
          args.items.map((item, i) =>
            ctx.step.agentTask(\`process:\${i}\`, { task: item.task }),
          ),
        );

        return ctx.step.rawLlm("summarize", { prompt: JSON.stringify(results) });
      }
    `);

    expect(result).toEqual({ ok: true });
  });

  test("rejects static labels in iteration method callbacks", () => {
    for (const method of ["map", "forEach", "reduce", "flatMap", "filter", "some", "every"]) {
      const result = lintWorkflowLabels(`
        export default async function main(args, ctx) {
          return args.items.${method}(((item) => ctx.step.agentTask("process", { task: item.task })));
        }
      `);

      expect(result.ok).toBe(false);
    }
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
