import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Schemas ────────────────────────────────────────────────

export const CodeMatchConfigSchema = z.object({
  code: z.string(),
  outputPorts: z.array(z.string()).min(1),
});

export const CodeMatchOutputSchema = z.object({
  port: z.string(),
  rawResult: z.unknown(),
});

// ─── Executor ───────────────────────────────────────────────

const SANDBOX_KEYS = [
  "require",
  "process",
  "Bun",
  "globalThis",
  "global",
  "fetch",
  "setTimeout",
  "setInterval",
] as const;

const SANDBOX_VALUES = SANDBOX_KEYS.map(() => undefined);

export class CodeMatchExecutor extends BaseExecutor<
  typeof CodeMatchConfigSchema,
  typeof CodeMatchOutputSchema
> {
  readonly type = "code-match";
  readonly mode = "instant" as const;
  readonly configSchema = CodeMatchConfigSchema;
  readonly outputSchema = CodeMatchOutputSchema;

  protected async execute(
    config: z.infer<typeof CodeMatchConfigSchema>,
    context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof CodeMatchOutputSchema>>> {
    try {
      // Build a sandboxed function — shadow dangerous globals in the function scope.
      // "import" is a reserved keyword and cannot be a parameter name, so it is
      // blocked by "use strict" scope.
      const fn = new Function(
        ...SANDBOX_KEYS,
        "input",
        `"use strict"; return (${config.code})(input);`,
      );

      const rawResult = fn(...SANDBOX_VALUES, context);

      // Map result to port name
      let port: string;
      if (typeof rawResult === "boolean") {
        port = rawResult ? "true" : "false";
      } else if (typeof rawResult === "string") {
        port = rawResult;
      } else {
        port = String(rawResult);
      }

      // Validate port is in the declared outputPorts
      if (!config.outputPorts.includes(port)) {
        return {
          status: "failed",
          error: `code-match returned "${port}" which is not in outputPorts: [${config.outputPorts.join(", ")}]`,
        };
      }

      return {
        status: "success",
        output: { port, rawResult },
        nextPort: port,
      };
    } catch (err) {
      return {
        status: "failed",
        error: `code-match execution error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
