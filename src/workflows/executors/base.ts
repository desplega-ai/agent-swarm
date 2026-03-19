import type { ZodType, z } from "zod";
import type { ExecutorMeta, RetryPolicy } from "../../types";
import type { WorkflowEventBus } from "../event-bus";

// ─── Dependencies ──────────────────────────────────────────

export interface ExecutorDependencies {
  db: typeof import("../../be/db");
  eventBus: WorkflowEventBus;
  interpolate: (template: string, ctx: Record<string, unknown>) => string;
}

// ─── Input / Result Types ──────────────────────────────────

export interface ExecutorInput {
  config: Record<string, unknown>;
  context: Readonly<Record<string, unknown>>;
  meta: ExecutorMeta;
}

export interface ExecutorResult<TOutput = unknown> {
  status: "success" | "failed" | "skipped";
  output?: TOutput;
  nextPort?: string;
  error?: string;
}

export interface AsyncExecutorResult<TOutput = unknown> extends ExecutorResult<TOutput> {
  async: true;
  waitFor: string;
  correlationId: string;
}

// ─── Base Executor ─────────────────────────────────────────

export abstract class BaseExecutor<
  TConfig extends ZodType = ZodType,
  TOutput extends ZodType = ZodType,
> {
  abstract readonly type: string;
  abstract readonly mode: "instant" | "async";
  abstract readonly configSchema: TConfig;
  abstract readonly outputSchema: TOutput;

  /** Optional default retry policy — can be overridden per node */
  readonly retryPolicy?: RetryPolicy;

  constructor(protected readonly deps: ExecutorDependencies) {}

  /**
   * Validate config, execute, validate output.
   * Catches Zod validation errors at both boundaries.
   */
  async run(input: ExecutorInput): Promise<ExecutorResult<z.infer<TOutput>>> {
    // Validate input config
    const configResult = this.configSchema.safeParse(input.config);
    if (!configResult.success) {
      return {
        status: "failed",
        error: `Input validation failed: ${configResult.error.message}`,
      };
    }

    const result = await this.execute(configResult.data, input.context, input.meta);

    // Validate output for successful results
    if (result.status === "success" && result.output !== undefined) {
      const outputResult = this.outputSchema.safeParse(result.output);
      if (!outputResult.success) {
        return {
          status: "failed",
          error: `Output validation failed: ${outputResult.error.message}`,
        };
      }
    }

    return result;
  }

  /** Implement this in each executor */
  protected abstract execute(
    config: z.infer<TConfig>,
    context: Readonly<Record<string, unknown>>,
    meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<TOutput>>>;
}
