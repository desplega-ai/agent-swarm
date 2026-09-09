import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { authorizeRoomNamespace, resolveRoomNamespace } from "@/realtime/auth";
import { RoomOperationSchema } from "@/realtime/document";
import { changeRoom, decodeRoomSnapshot, getRoom, resetRoom, roomView } from "@/realtime/rooms";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { KvNamespaceSchema } from "@/types";

const roomInput = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default("default"),
  namespace: KvNamespaceSchema.optional(),
  schemaVersion: z.number().int().positive().default(1),
});

const roomOutput = z.looseObject({
  namespace: z.string().optional(),
  name: z.string().optional(),
  schemaVersion: z.number().int().optional(),
  generation: z.string().optional(),
  stale: z.boolean().optional(),
  state: z.unknown().optional(),
  snapshot: z.string().optional(),
  bytes: z.number().int().optional(),
});

const decodedRoomOutput = z.looseObject({
  schemaVersion: z.number().int().optional(),
  generation: z.string().optional(),
  state: z.unknown().optional(),
  yourAgentId: z.string().optional(),
});

async function resolve(
  namespace: string | undefined,
  requestInfo: { agentId: string | undefined; sourceTaskId: string | undefined },
  write: boolean,
): Promise<{ namespace: string } | { error: string }> {
  const resolved = await resolveRoomNamespace(namespace, requestInfo);
  if ("error" in resolved) return resolved;
  const denial = await authorizeRoomNamespace(
    resolved.namespace,
    { ...requestInfo, callOrigin: "mcp" },
    write,
  );
  return denial ? { error: denial } : { namespace: resolved.namespace };
}

export const registerRoomGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "room-get",
    {
      title: "Room Get",
      description: "Read the current state of a realtime room.",
      annotations: { readOnlyHint: true },
      inputSchema: roomInput,
      outputSchema: swarmToolOutputSchema({
        room: roomOutput.optional(),
        yourAgentId: z.string().optional(),
      }),
    },
    async ({ name, namespace, schemaVersion }, requestInfo) => {
      const resolved = await resolve(namespace, requestInfo, false);
      if ("error" in resolved)
        return toolErr(resolved.error, { data: { yourAgentId: requestInfo.agentId } });
      try {
        const room = await getRoom(resolved.namespace, name, schemaVersion, { create: false });
        const view = roomView(room, schemaVersion);
        return toolOk(`Read room "${name}" in "${resolved.namespace}".`, {
          data: { room: view, yourAgentId: requestInfo.agentId },
        });
      } catch (error) {
        return toolErr(error instanceof Error ? error.message : "Room read failed", {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }
    },
  );
};

export const registerRoomChangeTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "room-change",
    {
      title: "Room Change",
      description: "Apply operations to the live state of a realtime room.",
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: roomInput.extend({ operations: z.array(RoomOperationSchema).min(1).max(1000) }),
      outputSchema: swarmToolOutputSchema({
        room: roomOutput.optional(),
        yourAgentId: z.string().optional(),
      }),
      rbac: { permission: "kv.write.any" },
    },
    async ({ name, namespace, schemaVersion, operations }, requestInfo) => {
      const resolved = await resolve(namespace, requestInfo, true);
      if ("error" in resolved)
        return toolErr(resolved.error, { data: { yourAgentId: requestInfo.agentId } });
      try {
        const room = await changeRoom(resolved.namespace, name, operations, schemaVersion);
        return toolOk(`Changed room "${name}" in "${resolved.namespace}".`, {
          data: { room, yourAgentId: requestInfo.agentId },
        });
      } catch (error) {
        return toolErr(error instanceof Error ? error.message : "Room change failed", {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }
    },
  );
};

export const registerRoomResetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "room-reset",
    {
      title: "Room Reset",
      description: "Replace a realtime room with a new state and schema version.",
      annotations: { destructiveHint: true, idempotentHint: false },
      inputSchema: roomInput.extend({ state: z.unknown().optional() }),
      outputSchema: swarmToolOutputSchema({
        room: roomOutput.optional(),
        yourAgentId: z.string().optional(),
      }),
      rbac: { permission: "kv.write.any" },
    },
    async ({ name, namespace, schemaVersion, state }, requestInfo) => {
      const resolved = await resolve(namespace, requestInfo, true);
      if ("error" in resolved)
        return toolErr(resolved.error, { data: { yourAgentId: requestInfo.agentId } });
      try {
        const room = await resetRoom(resolved.namespace, name, state ?? {}, schemaVersion);
        return toolOk(`Reset room "${name}" in "${resolved.namespace}".`, {
          data: { room, yourAgentId: requestInfo.agentId },
        });
      } catch (error) {
        return toolErr(error instanceof Error ? error.message : "Room reset failed", {
          data: { yourAgentId: requestInfo.agentId, namespace: resolved.namespace },
        });
      }
    },
  );
};

export const registerRoomDecodeTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "room-decode",
    {
      title: "Room Decode",
      description: "Decode a room snapshot value that the caller already holds.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ value: z.unknown() }),
      outputSchema: swarmToolOutputSchema({
        ...decodedRoomOutput.shape,
      }),
    },
    async ({ value }, requestInfo) => {
      try {
        return toolOk("Decoded room snapshot.", {
          data: { ...decodeRoomSnapshot(value), yourAgentId: requestInfo.agentId },
        });
      } catch (error) {
        return toolErr(error instanceof Error ? error.message : "Room decode failed", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
