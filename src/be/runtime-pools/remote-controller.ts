import { WebSocket } from "ws";
import { z } from "zod";
import {
  type ControllerCommands,
  ControllerOfflineError,
} from "../../runtime-providers/controller";
import {
  CONTROLLER_COMMAND_TIMEOUT_MS,
  type ControllerCommand,
  ControllerStatusResultSchema,
  RuntimeHandleSchema,
} from "../../runtime-providers/controller-protocol";
import type {
  ProvisionRequest,
  RuntimeHandle,
  RuntimeProviderTraits,
  RuntimeStatus,
} from "../../runtime-providers/types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { validateConfigValue } from "../swarm-config-guard";

const sessions = new Map<string, RemoteController>();
type CommandInput<T = ControllerCommand> = T extends ControllerCommand
  ? Omit<T, "id" | "type">
  : never;

export function remoteControllerSession(id: string): RemoteController | undefined {
  return sessions.get(id);
}

export function installRemoteController(session: RemoteController): void {
  const previous = sessions.get(session.id);
  sessions.set(session.id, session);
  previous?.disconnect("Controller connection replaced");
}

export function removeRemoteController(session: RemoteController): boolean {
  if (sessions.get(session.id) !== session) return false;
  sessions.delete(session.id);
  return true;
}

export class RemoteController implements ControllerCommands {
  private readonly pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  readonly renew?: ControllerCommands["renew"];
  readonly pause?: ControllerCommands["pause"];
  readonly resume?: ControllerCommands["resume"];

  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
    readonly traits: RuntimeProviderTraits,
    readonly workerApiUrl?: string,
    private readonly timeouts: { commandTimeoutMs?: number; provisionTimeoutMs?: number } = {},
  ) {
    if (traits.maxTtlSec)
      this.renew = async (handle, ttlSec) =>
        z
          .object({ endAt: z.string() })
          .parse(await this.call({ op: "renew", payload: { handle, ttlSec } }));
    if (traits.supportsPause) {
      this.pause = async (handle) => {
        await this.call({ op: "pause", payload: { handle } });
      };
      this.resume = async (handle) => {
        await this.call({ op: "resume", payload: { handle } });
      };
    }
  }

  disconnect(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ControllerOfflineError(this.id));
    }
    this.pending.clear();
    this.ws.close(1001, reason);
    setTimeout(() => this.ws.terminate(), 500).unref();
  }

  result(message: { id: string; ok: boolean; result?: unknown; error?: string }): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(scrubSecrets(message.error ?? "Controller command failed")));
  }

  private async call(command: CommandInput): Promise<unknown> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN)
      throw new ControllerOfflineError(this.id);
    const id = crypto.randomUUID();
    const configured = process.env.RUNTIME_PROVISION_TIMEOUT_SEC;
    const timeoutMs =
      command.op === "provision"
        ? (this.timeouts.provisionTimeoutMs ??
          (configured !== undefined &&
          validateConfigValue("RUNTIME_PROVISION_TIMEOUT_SEC", configured) === null
            ? Number(configured) * 1000
            : 300_000))
        : (this.timeouts.commandTimeoutMs ?? CONTROLLER_COMMAND_TIMEOUT_MS);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ControllerOfflineError(this.id, `Controller command ${command.op} timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...command, type: "cmd", id }), (error) => {
        if (error) this.disconnect("Controller connection failed");
      });
    });
  }

  async provision(req: ProvisionRequest): Promise<RuntimeHandle> {
    const handle = RuntimeHandleSchema.parse(await this.call({ op: "provision", payload: req }));
    return { ...handle, controllerId: this.id };
  }
  async terminate(handle: RuntimeHandle, reason: string): Promise<void> {
    await this.call({ op: "terminate", payload: { handle, reason } });
  }
  async status(handles: RuntimeHandle[]): Promise<Record<string, RuntimeStatus>> {
    return ControllerStatusResultSchema.parse(
      await this.call({ op: "status", payload: { handles } }),
    );
  }
  async list(ownerId: string): Promise<RuntimeHandle[]> {
    const handles = z
      .array(RuntimeHandleSchema)
      .parse(await this.call({ op: "list", payload: { ownerId } }));
    return handles.map((handle) => ({ ...handle, controllerId: this.id }));
  }
}
