import { stdlib } from "../scripts-runtime/stdlib";
import { WORKFLOW_SWARM_CAPABILITY_ALLOWLIST } from "./swarm-capabilities";
import type { WorkflowCtx } from "./workflow-ctx";

export type InvokeTool = (path: string, argsJson: string) => Promise<string>;

function encodeArgs(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function invokeJson(invokeTool: InvokeTool, path: string, args: unknown): Promise<unknown> {
  const resultJson = await invokeTool(path, encodeArgs(args));
  return JSON.parse(resultJson);
}

/**
 * Build the public workflow context inside the credential-free guest. Every
 * privileged operation is a JSON capability call into the host process; this
 * realm never constructs an authenticated request.
 */
export function buildGuestWorkflowCtx(input: {
  runId: string;
  agentId: string;
  args: unknown;
  invokeTool: InvokeTool;
}): WorkflowCtx {
  const invokeStep = (name: string, label?: string, config?: unknown) =>
    invokeJson(input.invokeTool, `step.${name}`, label === undefined ? [] : [label, config]);

  const swarm = Object.fromEntries(
    WORKFLOW_SWARM_CAPABILITY_ALLOWLIST.map((method) => [
      method,
      (args?: unknown) => invokeJson(input.invokeTool, `swarm.${method}`, args ?? {}),
    ]),
  ) as WorkflowCtx["swarm"];

  return {
    run: { id: input.runId, agentId: input.agentId, args: input.args },
    step: {
      rawLlm: (label, config) => invokeStep("rawLlm", label, config),
      agentTask: (label, config) => invokeStep("agentTask", label, config),
      swarmScript: (label, config) => invokeStep("swarmScript", label, config),
      humanInTheLoop: () => invokeStep("humanInTheLoop") as Promise<never>,
    },
    swarm,
    stdlib,
    logger: console,
  };
}
