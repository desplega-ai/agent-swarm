import type { SwarmSdk } from "swarm-sdk";
import { insertExtensionRun } from "../be/extensions/db";
import { invokeToolInProcess } from "../http/mcp-bridge";
import { SDK_TOOL_NAME_MAP } from "../scripts-runtime/sdk-allowlist";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import { getApiKey } from "../utils/api-key";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { ApiCtx, ExtensionLogger, ExtensionState, SwarmEventMap } from "./contract";
import { ExtensionAbortedError, isRegistered } from "./dispatcher";
import { getExtensionLoopbackBaseUrl } from "./lifecycle";
import type { LoadedExtension } from "./loader";

type WireToolResult = {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function wireResult(value: unknown): WireToolResult {
  if (!value || typeof value !== "object") return {};
  return value as WireToolResult;
}

async function callExtensionTool(
  loaded: LoadedExtension,
  toolName: string,
  args?: unknown,
): Promise<WireToolResult> {
  if (!loaded.record.agentId) throw new Error("Extension agent identity is missing");
  return wireResult(
    await invokeToolInProcess({
      toolName,
      args,
      agentId: loaded.record.agentId,
      callOrigin: "extension",
    }),
  );
}

function prefixedStateKey(loaded: LoadedExtension, key: string): string {
  return `ext:${loaded.record.name}:${key}`;
}

function createExtensionState(loaded: LoadedExtension): ExtensionState {
  const invoke = async (toolName: string, args: Record<string, unknown>) => {
    const result = await callExtensionTool(loaded, toolName, args);
    const data = result.structuredContent ?? {};
    if (result.isError) throw new Error(String(data.message ?? `${toolName} failed`));
    return data;
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      const data = await invoke(SDK_TOOL_NAME_MAP.kv_get, { key: prefixedStateKey(loaded, key) });
      const entry = data.entry as { value?: T } | null | undefined;
      return entry?.value ?? null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      await invoke(SDK_TOOL_NAME_MAP.kv_set, { key: prefixedStateKey(loaded, key), value });
    },
    async incr(key: string, by = 1): Promise<number> {
      const data = await invoke(SDK_TOOL_NAME_MAP.kv_incr, {
        key: prefixedStateKey(loaded, key),
        by,
      });
      const entry = data.entry as { value?: unknown } | undefined;
      if (typeof entry?.value !== "number") throw new Error("KV increment returned no number");
      return entry.value;
    },
    async del(key: string): Promise<void> {
      await invoke(SDK_TOOL_NAME_MAP.kv_delete, { key: prefixedStateKey(loaded, key) });
    },
  };
}

function logText(message: string, data?: unknown): string {
  let suffix = "";
  if (data !== undefined) {
    try {
      suffix = ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
    } catch {
      suffix = " [unserializable]";
    }
  }
  return scrubSecrets(`${message}${suffix}`);
}

function createExtensionLogger(
  loaded: LoadedExtension,
  eventName: keyof SwarmEventMap,
): ExtensionLogger {
  const prefix = `[extension:${loaded.record.name}]`;
  return {
    debug(message, data) {
      console.debug(prefix, logText(message, data));
    },
    info(message, data) {
      console.info(prefix, logText(message, data));
    },
    warn(message, data) {
      console.warn(prefix, logText(message, data));
    },
    error(message, data) {
      const text = logText(message, data);
      console.error(prefix, text);
      void insertExtensionRun({
        extensionId: loaded.record.id,
        version: loaded.record.activeVersion,
        event: eventName,
        action: "error",
        message: text,
      }).catch((error) => {
        console.error(
          "[extensions] Failed to store extension log:",
          scrubSecrets(error instanceof Error ? error.message : String(error)),
        );
      });
    },
  };
}

export function buildCtx(
  loaded: LoadedExtension,
  eventName: keyof SwarmEventMap,
  signal: AbortSignal,
): ApiCtx {
  const assertActive = () => {
    if (signal.aborted || !isRegistered(loaded.record.id)) throw new ExtensionAbortedError();
  };
  const guard = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          assertActive();
          return Reflect.apply(value, object, args);
        };
      },
    });

  // Defer SDK construction until a call, because boot precedes the HTTP listener.
  let sdk: ReturnType<typeof createSwarmSdk> | undefined;
  const getSdk = () => {
    if (!loaded.record.agentId) throw new Error("Extension agent identity is missing");
    sdk ??= createSwarmSdk(
      new SwarmConfig({
        system: {
          apiKey: { value: getApiKey(), isSecret: true },
          agentId: { value: loaded.record.agentId, isSecret: false },
          mcpBaseUrl: { value: getExtensionLoopbackBaseUrl(), isSecret: false },
        },
        user: {},
      }),
    );
    return sdk;
  };
  const swarmProxy = (room = false): object =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (!room && property === "room") return swarmProxy(true);
          if (typeof property !== "string") return undefined;
          return async (...args: unknown[]) => {
            assertActive();
            const target = room ? getSdk().room : getSdk();
            return await Reflect.apply(Reflect.get(target, property), target, args);
          };
        },
      },
    );
  return {
    swarm: swarmProxy() as SwarmSdk,
    state: guard(createExtensionState(loaded)),
    config: loaded.config,
    log: guard(createExtensionLogger(loaded, eventName)),
    signal,
    event: {
      name: eventName,
      at: new Date().toISOString(),
      extension: { id: loaded.record.id, version: loaded.record.activeVersion },
    },
  };
}
