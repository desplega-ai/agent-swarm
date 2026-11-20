import { z } from "zod";
import type { ExecutorMeta } from "../../types";
import { evaluatePredicate } from "../predicate-sandbox";
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

// CPU budget for one predicate. It runs synchronously on the API thread.
const CODE_MATCH_TIMEOUT_MS = 1_000;

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
      const result = await evaluatePredicate(config.code, context, "port", {
        timeoutMs: CODE_MATCH_TIMEOUT_MS,
        strict: true,
      });
      if (!result.ok) {
        return { status: "failed", error: `code-match execution error: ${result.error}` };
      }
      // The guest maps the return value to a port string (see predicate-sandbox).
      const { port, raw: rawResult } = result.value;

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
