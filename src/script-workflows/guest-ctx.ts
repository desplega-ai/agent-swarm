import {
  SDK_NAMESPACES,
  type SdkNamespaceRegistry,
  sdkMethodForNamespace,
  unwrapToolPayload,
} from "../scripts-runtime/sdk-allowlist";
import { stdlib } from "../scripts-runtime/stdlib";
import { WORKFLOW_SWARM_CAPABILITY_ALLOWLIST } from "./swarm-capabilities";
import type { SwarmCallOptions, SwarmCapabilityOptions, WorkflowCtx } from "./workflow-ctx";

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
  /** Tests inject a fixture; production uses `SDK_NAMESPACES`. */
  namespaces?: SdkNamespaceRegistry;
}): WorkflowCtx {
  const invokeStep = (name: string, label?: string, config?: unknown) =>
    invokeJson(input.invokeTool, `step.${name}`, label === undefined ? [] : [label, config]);

  // Each call gets its per-method ordinal in call order, synchronously, so a
  // re-executed run numbers its calls the same way and the host derives the
  // same idempotency key for each. An explicit `idempotencyKey` wins.
  const ordinals = new Map<string, number>();
  const invokeSwarm = (method: string, args: unknown, options: unknown) => {
    const ordinal = (ordinals.get(method) ?? 0) + 1;
    ordinals.set(method, ordinal);
    const explicit = (options as SwarmCallOptions | undefined)?.idempotencyKey;
    const callOptions: SwarmCapabilityOptions =
      typeof explicit === "string" ? { idempotencyKey: explicit } : { ordinal };
    return invokeJson(input.invokeTool, `swarm.${method}`, [args ?? {}, callOptions]);
  };

  const swarm = Object.fromEntries(
    WORKFLOW_SWARM_CAPABILITY_ALLOWLIST.map((method) => [
      method,
      (args?: unknown, options?: SwarmCallOptions) => invokeSwarm(method, args, options),
    ]),
  ) as WorkflowCtx["swarm"];

  // ctx.<ns>.<m> calls the flat, already allowlisted `swarm.<ns>_<m>` capability and unwraps it.
  const namespaces = Object.fromEntries(
    Object.entries(input.namespaces ?? SDK_NAMESPACES).map(([ns, methods]) => [
      ns,
      Object.freeze(
        Object.fromEntries(
          methods.map((method) => [
            method,
            async (args?: unknown) =>
              unwrapToolPayload(
                `ctx.${ns}.${method}`,
                await invokeSwarm(sdkMethodForNamespace(ns, method), args, undefined),
              ),
          ]),
        ),
      ),
    ]),
  );

  return {
    ...namespaces,
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
