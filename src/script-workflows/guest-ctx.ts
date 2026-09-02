import { isSdkToolAllowed } from "../scripts-runtime/sdk-allowlist";
import { stdlib } from "../scripts-runtime/stdlib";
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

  const swarm = new Proxy({} as Record<string, (args?: unknown) => Promise<unknown>>, {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      return (args?: unknown) => {
        // Match createSwarmSdk's public error while rejecting unknown or
        // sensitive properties before they cross the process boundary.
        if (!isSdkToolAllowed(prop)) {
          return Promise.reject(
            new Error(
              `Tool '${prop}' is not exposed to scripts (lifecycle/cred tool); use the MCP surface directly if you're an agent`,
            ),
          );
        }
        return invokeJson(input.invokeTool, `swarm.${prop}`, args ?? {});
      };
    },
  });

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
