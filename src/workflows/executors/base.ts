import type { ZodType, z } from "zod";
import type { ExecutorMeta, RetryPolicy } from "../../types";
import type { WorkflowEventBus } from "../event-bus";

// ─── Dependencies ──────────────────────────────────────────

export interface ExecutorDependencies {
  db: typeof import("../../be/db");
  eventBus: WorkflowEventBus;
  interpolate: (template: string, ctx: Record<string, unknown>) => string;
}

// ─── Readiness ─────────────────────────────────────────────

export interface ExecutorReadinessNode {
  id: string;
  config: Record<string, unknown>;
}

export interface ExecutorReadinessProblem {
  /** Nodes that hit this problem. */
  nodeIds: string[];
  message: string;
}

// ─── Approval resolution ───────────────────────────────────

/** A resolved approval request, as the resume and recovery paths see it. */
export interface ResolvedApproval {
  requestId: string;
  status: "approved" | "rejected" | "timeout";
  responses: Record<string, unknown> | null;
}

/** The step output and output port an executor chooses once its approval resolves. */
export interface ApprovalOutcome {
  output: unknown;
  nextPort: string;
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
   * Can this executor run the given nodes right now? Return one problem per
   * distinct missing prerequisite (for example a credential), or an empty array.
   * The engine asks before a run starts, and authoring surfaces ask after a
   * save, so a missing prerequisite surfaces before any node has side effects.
   * Reads raw (pre-interpolation) node config. Must not call external services
   * and must not put secret values in a message.
   */
  async checkReadiness(
    _nodes: readonly ExecutorReadinessNode[],
  ): Promise<ExecutorReadinessProblem[]> {
    return [];
  }

  /**
   * An executor that parks its step on a human-in-the-loop approval decides the
   * step's output and port once a person answers. `parkedOutput` is the step
   * output it stored before it parked. Return null to keep the default: the
   * human-in-the-loop output (`{ requestId, status, responses }`) on the port
   * named after the status.
   */
  resolveApproval(_parkedOutput: unknown, _approval: ResolvedApproval): ApprovalOutcome | null {
    return null;
  }

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

    let result: ExecutorResult<z.infer<TOutput>>;
    try {
      result = await this.execute(configResult.data, input.context, input.meta);
    } catch (err) {
      return {
        status: "failed",
        error: `Executor threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

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
