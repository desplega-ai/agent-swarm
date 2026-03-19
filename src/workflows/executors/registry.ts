import { AgentTaskExecutor } from "./agent-task";
import type { BaseExecutor, ExecutorDependencies } from "./base";
import { CodeMatchExecutor } from "./code-match";
import { NotifyExecutor } from "./notify";
import { PropertyMatchExecutor } from "./property-match";
import { RawLlmExecutor } from "./raw-llm";
import { ScriptExecutor } from "./script";
import { ValidateExecutor } from "./validate";
import { VcsExecutor } from "./vcs";

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

  return registry;
}
