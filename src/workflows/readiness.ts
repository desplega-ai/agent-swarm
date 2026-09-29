import type { WorkflowDefinition } from "../types";
import type { ExecutorReadinessNode } from "./executors/base";
import type { ExecutorRegistry } from "./executors/registry";

export interface WorkflowReadinessProblem {
  /** Executor type that reported the problem. */
  type: string;
  nodeIds: string[];
  message: string;
}

/**
 * Ask every executor type a definition uses whether it can run right now, e.g.
 * whether the credential a `system-one-decision` node needs is configured. Types are checked in
 * first-use order, one call per type. Unregistered types are skipped (definition
 * validation reports them). A check that throws is reported as a problem rather
 * than propagated, so a broken check can never crash a save or start a run blind.
 */
export async function findWorkflowReadinessProblems(
  definition: Pick<WorkflowDefinition, "nodes">,
  registry: ExecutorRegistry,
): Promise<WorkflowReadinessProblem[]> {
  const nodesByType = new Map<string, ExecutorReadinessNode[]>();
  for (const node of definition.nodes) {
    if (!registry.has(node.type)) continue;
    const group = nodesByType.get(node.type) ?? [];
    group.push({ id: node.id, config: node.config });
    nodesByType.set(node.type, group);
  }

  const problems: WorkflowReadinessProblem[] = [];
  for (const [type, nodes] of nodesByType) {
    try {
      for (const problem of await registry.get(type).checkReadiness(nodes)) {
        problems.push({ type, ...problem });
      }
    } catch {
      problems.push({
        type,
        nodeIds: nodes.map((node) => node.id),
        message: `Could not check whether "${type}" nodes are ready to run`,
      });
    }
  }
  return problems;
}

function describeNodes(problem: WorkflowReadinessProblem): string {
  const noun = problem.nodeIds.length === 1 ? "node" : "nodes";
  return `${problem.type} ${noun} ${problem.nodeIds.map((id) => `"${id}"`).join(", ")}`;
}

/**
 * Message an author gets when a save succeeded but a node cannot run yet.
 * The executor's own message comes first so it reads the same as at run start.
 */
export function formatReadinessWarning(problem: WorkflowReadinessProblem): string {
  return `${problem.message} Affects ${describeNodes(problem)}. Runs of this workflow fail before any node executes until this is fixed.`;
}

/** The problems as one sentence list; callers prefix what was stopped. */
export function formatReadinessProblems(problems: readonly WorkflowReadinessProblem[]): string {
  return problems
    .map((problem) => `${problem.message} Needed by ${describeNodes(problem)}.`)
    .join(" ");
}

/** Error recorded on a run that was stopped before any node executed. */
export function formatReadinessRunError(problems: readonly WorkflowReadinessProblem[]): string {
  return `Run not started, no node executed: ${formatReadinessProblems(problems)}`;
}

/** Warnings for a definition that was just saved. Empty when every executor is ready. */
export async function workflowSaveWarnings(
  definition: Pick<WorkflowDefinition, "nodes">,
  registry: ExecutorRegistry,
): Promise<string[]> {
  return (await findWorkflowReadinessProblems(definition, registry)).map(formatReadinessWarning);
}

/** Append save-time warnings to a tool message so the author sees them in the summary. */
export function withSaveWarnings(text: string, warnings: readonly string[]): string {
  return warnings.length === 0
    ? text
    : `${text} ${warnings.map((warning) => `Warning: ${warning}`).join(" ")}`;
}
