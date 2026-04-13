import { z } from "zod";
import { AgentTaskExecutor } from "./agent-task";
import type { BaseExecutor, ExecutorDependencies } from "./base";
import { CodeMatchExecutor } from "./code-match";
import { HumanInTheLoopExecutor } from "./human-in-the-loop";
import { NotifyExecutor } from "./notify";
import { PropertyMatchExecutor } from "./property-match";
import { RawLlmExecutor } from "./raw-llm";
import { ScriptExecutor } from "./script";
import { ValidateExecutor } from "./validate";
import { VcsExecutor } from "./vcs";

export interface ExecutorTypeInfo {
  type: string;
  mode: "instant" | "async";
  configSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export class ExecutorRegistry {
  private executors = new Map<string, BaseExecutor>();

  register(executor: BaseExecutor): void {
    this.executors.set(executor.type, executor);
  }

  get(type: string): BaseExecutor {
    const executor = this.executors.get(type);
    if (!executor) throw new Error(`Unknown executor type: ${type}`);
    return executor;
  }

  has(type: string): boolean {
    return this.executors.has(type);
  }

  types(): string[] {
    return [...this.executors.keys()];
  }

  /** Return JSON Schema metadata for a single executor type */
  describe(type: string): ExecutorTypeInfo {
    const executor = this.get(type);
    return {
      type: executor.type,
      mode: executor.mode,
      configSchema: z.toJSONSchema(executor.configSchema) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(executor.outputSchema) as Record<string, unknown>,
    };
  }

  /** Return JSON Schema metadata for all executor types */
  describeAll(): ExecutorTypeInfo[] {
    return this.types().map((t) => this.describe(t));
  }
}

/**
 * Create an executor registry with all built-in executors registered.
 */
export function createExecutorRegistry(deps: ExecutorDependencies): ExecutorRegistry {
  const registry = new ExecutorRegistry();

  // Instant executors (Phase 2)
  registry.register(new PropertyMatchExecutor(deps));
  registry.register(new CodeMatchExecutor(deps));
  registry.register(new NotifyExecutor(deps));
  registry.register(new RawLlmExecutor(deps));
  registry.register(new ScriptExecutor(deps));
  registry.register(new VcsExecutor(deps));
  registry.register(new ValidateExecutor(deps));

  // Async executors (Phase 4)
  registry.register(new AgentTaskExecutor(deps));
  registry.register(new HumanInTheLoopExecutor(deps));

  return registry;
}
