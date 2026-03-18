import type { BaseExecutor, ExecutorDependencies } from "./base";

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
 * Individual executor classes will be registered here as they are implemented in Phase 2.
 */
export function createExecutorRegistry(_deps: ExecutorDependencies): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  // Phase 2 will register all instant executors here:
  // registry.register(new PropertyMatchExecutor(deps));
  // registry.register(new CodeMatchExecutor(deps));
  // registry.register(new NotifyExecutor(deps));
  // registry.register(new RawLlmExecutor(deps));
  // registry.register(new ScriptExecutor(deps));
  // registry.register(new VcsExecutor(deps));
  // registry.register(new ValidateExecutor(deps));
  // Phase 4 will add:
  // registry.register(new AgentTaskExecutor(deps));
  return registry;
}
