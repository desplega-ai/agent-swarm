// @swarm/workflows barrel — hand-maintained since Phase 5 extraction.
// Sources live under ./src/. Namespaced (`export * as`) re-exports below resolve
// name collisions where a submodule barrel re-exports symbols already flat-exported.
// Symbols unique to a namespaced module are re-exposed flat at the bottom.

// Collision-safe flat re-exports of symbols that live only inside a namespaced module.
export { getExecutorRegistry, initWorkflows } from "./src/workflows/index";
export { createStandaloneScheduleTask } from "./src/scheduler/scheduler";

export * from "./src/scheduler/index";
export * as SchedulerScheduler from "./src/scheduler/scheduler";
export * from "./src/tasks/additive-buffer";
export * from "./src/tasks/additive-ingress";
export * from "./src/tasks/context-key";
export * from "./src/tasks/sibling-awareness";
export * from "./src/tasks/sibling-block";
export * from "./src/tasks/worker-follow-up";
export * from "./src/workflows/checkpoint";
export * from "./src/workflows/cooldown";
export * from "./src/workflows/definition";
export * from "./src/workflows/engine";
export * from "./src/workflows/event-bus";
export * from "./src/workflows/executors/agent-task";
export * from "./src/workflows/executors/base";
export * from "./src/workflows/executors/code-match";
export * from "./src/workflows/executors/human-in-the-loop";
export * as WorkflowsExecutorsIndex from "./src/workflows/executors/index";
export * from "./src/workflows/executors/notify";
export * from "./src/workflows/executors/property-match";
export * from "./src/workflows/executors/raw-llm";
export * from "./src/workflows/executors/registry";
export * from "./src/workflows/executors/script";
export * from "./src/workflows/executors/swarm-script";
export * from "./src/workflows/executors/validate";
export * from "./src/workflows/executors/vcs";
export * from "./src/workflows/executors/wait";
export * as WorkflowsIndex from "./src/workflows/index";
export * from "./src/workflows/input";
export * from "./src/workflows/json-schema-validator";
export * from "./src/workflows/recovery";
export * from "./src/workflows/resume";
export * from "./src/workflows/retry-poller";
export * from "./src/workflows/template";
export * from "./src/workflows/templates";
export * from "./src/workflows/triggers";
export * from "./src/workflows/validation";
export * from "./src/workflows/version";
export * from "./src/workflows/wait-filter";
export * from "./src/workflows/wait-poller";
