import { SCRIPT_SDK_RESPONSE_LIMIT_BYTES } from "../scripts-runtime/response-limit";
import { handleCapabilityRequest, MAX_PENDING_CAPABILITY_CALLS } from "./capability-bridge";
import type { StartScriptExecutionInput } from "./executor";
import { scriptRunMaxWallMs } from "./limits";
import { isWorkflowSwarmCapabilityAllowed } from "./swarm-capabilities";
import { type BuiltWorkflowCtx, buildWorkflowCtx } from "./workflow-ctx";

export const MAX_ACTIVE_CAPABILITY_DISPATCHES = 8;
function stringifyResult(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export async function dispatchCapability(
  built: BuiltWorkflowCtx,
  path: string,
  argsJson: string,
): Promise<string> {
  const args = JSON.parse(argsJson) as unknown;

  if (path.startsWith("swarm.")) {
    const method = path.slice("swarm.".length);
    if (!method || method.includes(".")) throw new Error(`Invalid swarm capability path: ${path}`);
    if (!isWorkflowSwarmCapabilityAllowed(method)) {
      throw new Error(`Workflow swarm capability '${method}' is not allowlisted`);
    }
    const capability = built.ctx.swarm[method];
    if (!capability) throw new Error(`Unknown workflow capability: ${path}`);
    return stringifyResult(await capability(args));
  }

  if (path === "step.humanInTheLoop") {
    return stringifyResult(await built.ctx.step.humanInTheLoop());
  }

  if (!Array.isArray(args) || args.length !== 2 || typeof args[0] !== "string") {
    throw new Error(`Invalid arguments for capability ${path}`);
  }
  const [label, config] = args;
  switch (path) {
    case "step.rawLlm":
      return stringifyResult(
        await built.ctx.step.rawLlm(label, config as Parameters<typeof built.ctx.step.rawLlm>[1]),
      );
    case "step.agentTask":
      return stringifyResult(
        await built.ctx.step.agentTask(
          label,
          config as Parameters<typeof built.ctx.step.agentTask>[1],
        ),
      );
    case "step.swarmScript":
      return stringifyResult(
        await built.ctx.step.swarmScript(
          label,
          config as Parameters<typeof built.ctx.step.swarmScript>[1],
        ),
      );
    default:
      throw new Error(`Unknown workflow capability: ${path}`);
  }
}

/** The API retains credentials and capability state across transport reconnects. */
export function createCapabilitySession(
  input: StartScriptExecutionInput,
  token: string,
  replayResponses = false,
) {
  const { run, apiKey, baseUrl } = input;
  const built = buildWorkflowCtx({
    ownerId: input.ownerId,
    runId: run.id,
    agentId: run.agentId,
    apiKey,
    baseUrl,
    args: run.args,
    runStartedAt: run.startedAt,
    runMaxWallMs: scriptRunMaxWallMs(),
  });
  let authenticated = false;
  let pending = 0;
  let active = 0;
  let queuedBytes = 0;
  let closed = false;
  const responses = new Map<string, Promise<string>>();
  let retainedBytes = 0;
  const responseSizes = new Map<string, number>();
  const waiters: Array<() => void> = [];
  const dispatch = async (path: string, args: string) => {
    if (closed) throw new Error("Capability session closed");
    if (!path.startsWith("swarm.")) {
      if (input.authorizeCapability && !(await input.authorizeCapability()))
        throw new Error("Durable ownership expired");
      return dispatchCapability(built, path, args);
    }
    if (active >= MAX_ACTIVE_CAPABILITY_DISPATCHES)
      await new Promise<void>((resolve) => waiters.push(resolve));
    else active++;
    try {
      if (closed) throw new Error("Capability session closed");
      if (input.authorizeCapability && !(await input.authorizeCapability()))
        throw new Error("Durable ownership expired");
      return await dispatchCapability(built, path, args);
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
  return {
    built,
    authenticate(frame: string): boolean {
      if (closed || authenticated || Buffer.byteLength(frame) > 4096) return false;
      try {
        const hello = JSON.parse(frame);
        authenticated = hello?.type === "hello" && hello?.token === token;
      } catch {
        return false;
      }
      return authenticated;
    },
    confirmResponse(id: string) {
      const bytes = responseSizes.get(id);
      if (bytes === undefined) return;
      retainedBytes -= bytes;
      responseSizes.delete(id);
      responses.delete(id);
    },
    async receive(frame: string, send: (response: string) => Promise<void>) {
      if (closed || !authenticated) throw new Error("Capability session is not authenticated");
      if (Buffer.byteLength(frame) > SCRIPT_SDK_RESPONSE_LIMIT_BYTES)
        throw new Error("Capability request exceeds limit");
      const write = async (response: string) => {
        const bytes = Buffer.byteLength(response) + 1;
        if (closed) return;
        if (queuedBytes + bytes > SCRIPT_SDK_RESPONSE_LIMIT_BYTES)
          throw new Error("Capability response queue exceeds limit");
        queuedBytes += bytes;
        try {
          await send(response);
        } finally {
          queuedBytes -= bytes;
        }
      };
      const request = JSON.parse(frame);
      const id = request.id;
      if (replayResponses && typeof id !== "string")
        throw new Error("Invalid capability request ID");
      const previous = replayResponses ? responses.get(id) : undefined;
      if (previous) {
        await write(await previous);
        return;
      }
      if (
        pending >= MAX_PENDING_CAPABILITY_CALLS ||
        (replayResponses && responses.size >= MAX_PENDING_CAPABILITY_CALLS)
      ) {
        await write(
          await handleCapabilityRequest(frame, async () => {
            throw new Error(
              `Capability pending call limit of ${MAX_PENDING_CAPABILITY_CALLS} exceeded`,
            );
          }),
        );
        return;
      }
      pending++;
      try {
        const result = handleCapabilityRequest(frame, dispatch).then((response) => {
          if (replayResponses) {
            const bytes = Buffer.byteLength(response);
            if (retainedBytes + bytes > SCRIPT_SDK_RESPONSE_LIMIT_BYTES)
              throw new Error("Capability replay cache exceeds limit");
            retainedBytes += bytes;
            responseSizes.set(id, bytes);
          }
          return response;
        });
        if (replayResponses) responses.set(id, result);
        await write(await result);
      } finally {
        pending--;
      }
    },
    close() {
      closed = true;
      responses.clear();
      responseSizes.clear();
      built.abortInFlightSteps();
      for (const resume of waiters.splice(0)) resume();
    },
  };
}
