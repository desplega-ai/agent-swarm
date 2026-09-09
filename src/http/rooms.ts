import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { authorizeRoomNamespace, resolveRoomNamespace, roomRequestInfo } from "../realtime/auth";
import { RoomOperationSchema } from "../realtime/document";
import { changeRoom, decodeRoomSnapshot, getRoom, resetRoom, roomView } from "../realtime/rooms";
import { KvNamespaceSchema } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

const roomArgsSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default("default"),
  namespace: KvNamespaceSchema.optional(),
  schemaVersion: z.number().int().positive().default(1),
});
const ROOM_MAX_BODY_BYTES = 3 * 1024 * 1024;

const roomViewSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  schemaVersion: z.number().int(),
  generation: z.string(),
  stale: z.boolean(),
  state: z.unknown(),
  snapshot: z.string(),
  bytes: z.number().int().nonnegative(),
});

const roomGetRoute = route({
  method: "post",
  path: "/api/rooms/get",
  pattern: ["api", "rooms", "get"],
  summary: "Read a realtime room",
  tags: ["Rooms"],
  body: roomArgsSchema,
  maxBodyBytes: ROOM_MAX_BODY_BYTES,
  responses: {
    200: { description: "Room view", schema: z.object({ room: roomViewSchema }) },
    400: { description: "Validation or room error" },
    403: { description: "Room access denied" },
    404: { description: "Room not found" },
    413: { description: "Request body exceeds the room body limit" },
  },
  rbac: { ungated: "room reads are guarded by the namespace helper" },
  auth: { apiKey: true },
});

const roomGetQueryRoute = route({
  method: "get",
  path: "/api/rooms/get",
  pattern: ["api", "rooms", "get"],
  summary: "Read a realtime room",
  tags: ["Rooms"],
  query: z.object({
    name: roomArgsSchema.shape.name,
    namespace: KvNamespaceSchema.optional(),
    schemaVersion: z.coerce.number().int().positive().default(1),
  }),
  responses: {
    200: { description: "Room view", schema: z.object({ room: roomViewSchema }) },
    400: { description: "Validation or room error" },
    403: { description: "Room access denied" },
    404: { description: "Room not found" },
  },
  rbac: { ungated: "room reads are guarded by the namespace helper" },
  auth: { apiKey: true },
});

const roomChangeRoute = route({
  method: "post",
  path: "/api/rooms/change",
  pattern: ["api", "rooms", "change"],
  summary: "Apply operations to a realtime room",
  tags: ["Rooms"],
  body: roomArgsSchema.extend({ operations: z.array(RoomOperationSchema).min(1).max(1000) }),
  maxBodyBytes: ROOM_MAX_BODY_BYTES,
  responses: {
    200: { description: "Changed room view", schema: z.object({ room: roomViewSchema }) },
    400: { description: "Validation or room error" },
    403: { description: "Room write denied" },
    409: { description: "Room schema or size conflict" },
    413: { description: "Request body exceeds the room body limit" },
  },
  rbac: { permission: "kv.write.any" },
  auth: { apiKey: true },
});

const roomResetRoute = route({
  method: "post",
  path: "/api/rooms/reset",
  pattern: ["api", "rooms", "reset"],
  summary: "Reset a realtime room",
  tags: ["Rooms"],
  body: roomArgsSchema.extend({ state: z.unknown().optional() }),
  maxBodyBytes: ROOM_MAX_BODY_BYTES,
  responses: {
    200: { description: "Reset room view", schema: z.object({ room: roomViewSchema }) },
    400: { description: "Validation or room error" },
    403: { description: "Room write denied" },
    413: { description: "Request body exceeds the room body limit" },
  },
  rbac: { permission: "kv.write.any" },
  auth: { apiKey: true },
});

const roomDecodeRoute = route({
  method: "post",
  path: "/api/rooms/decode",
  pattern: ["api", "rooms", "decode"],
  summary: "Decode a realtime room snapshot",
  tags: ["Rooms"],
  body: z.object({ value: z.unknown() }),
  maxBodyBytes: ROOM_MAX_BODY_BYTES,
  responses: {
    200: {
      description: "Decoded room state",
      schema: z.object({
        schemaVersion: z.number().int(),
        generation: z.string(),
        state: z.unknown(),
      }),
    },
    400: { description: "Invalid room snapshot" },
    413: { description: "Request body exceeds the room body limit" },
  },
  rbac: { ungated: "decoder only processes a snapshot already held by the caller" },
  auth: { apiKey: false },
});

function errorStatus(message: string): 400 | 403 | 404 | 409 {
  if (/denied|required|permission|namespace/i.test(message)) return 403;
  if (/does not exist|not found/i.test(message)) return 404;
  if (/stale|schema|size|limit|cap/i.test(message)) return 409;
  return 400;
}

function sendRoomError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : "Room operation failed";
  jsonError(res, message, errorStatus(message));
}

export async function handleRooms(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (roomGetQueryRoute.match(req.method, pathSegments)) {
    const parsed = await roomGetQueryRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const auth = getRequestAuth(req);
    const info = roomRequestInfo(req, auth);
    const resolved = await resolveRoomNamespace(parsed.query.namespace, info);
    if ("error" in resolved) {
      jsonError(res, resolved.error, 400);
      return true;
    }
    const denial = await authorizeRoomNamespace(
      resolved.namespace,
      {
        ...info,
        callOrigin: "http",
        userId: auth?.kind === "user" ? auth.userId : undefined,
        isOperator: auth?.kind === "operator",
      },
      false,
    );
    if (denial) {
      jsonError(res, denial, 403);
      return true;
    }
    try {
      const room = await getRoom(
        resolved.namespace,
        parsed.query.name,
        parsed.query.schemaVersion,
        {
          create: false,
        },
      );
      roomGetQueryRoute.respond(res, 200, { room: roomView(room, parsed.query.schemaVersion) });
    } catch (error) {
      sendRoomError(res, error);
    }
    return true;
  }

  if (roomGetRoute.match(req.method, pathSegments)) {
    const parsed = await roomGetRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const auth = getRequestAuth(req);
    const info = roomRequestInfo(req, auth);
    const resolved = await resolveRoomNamespace(parsed.body.namespace, info);
    if ("error" in resolved) {
      jsonError(res, resolved.error, 400);
      return true;
    }
    const denial = await authorizeRoomNamespace(
      resolved.namespace,
      {
        ...info,
        callOrigin: "http",
        userId: auth?.kind === "user" ? auth.userId : undefined,
        isOperator: auth?.kind === "operator",
      },
      false,
    );
    if (denial) {
      jsonError(res, denial, 403);
      return true;
    }
    try {
      const room = await getRoom(resolved.namespace, parsed.body.name, parsed.body.schemaVersion, {
        create: false,
      });
      roomGetRoute.respond(res, 200, { room: roomView(room, parsed.body.schemaVersion) });
    } catch (error) {
      sendRoomError(res, error);
    }
    return true;
  }

  if (roomChangeRoute.match(req.method, pathSegments)) {
    const parsed = await roomChangeRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const auth = getRequestAuth(req);
    const info = roomRequestInfo(req, auth);
    const resolved = await resolveRoomNamespace(parsed.body.namespace, info);
    if ("error" in resolved) {
      jsonError(res, resolved.error, 400);
      return true;
    }
    const denial = await authorizeRoomNamespace(
      resolved.namespace,
      {
        ...info,
        callOrigin: "http",
        userId: auth?.kind === "user" ? auth.userId : undefined,
        isOperator: auth?.kind === "operator",
      },
      true,
    );
    if (denial) {
      jsonError(res, denial, 403);
      return true;
    }
    try {
      const room = await changeRoom(
        resolved.namespace,
        parsed.body.name,
        parsed.body.operations,
        parsed.body.schemaVersion,
      );
      roomChangeRoute.respond(res, 200, { room });
    } catch (error) {
      sendRoomError(res, error);
    }
    return true;
  }

  if (roomResetRoute.match(req.method, pathSegments)) {
    const parsed = await roomResetRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const auth = getRequestAuth(req);
    const info = roomRequestInfo(req, auth);
    const resolved = await resolveRoomNamespace(parsed.body.namespace, info);
    if ("error" in resolved) {
      jsonError(res, resolved.error, 400);
      return true;
    }
    const denial = await authorizeRoomNamespace(
      resolved.namespace,
      {
        ...info,
        callOrigin: "http",
        userId: auth?.kind === "user" ? auth.userId : undefined,
        isOperator: auth?.kind === "operator",
      },
      true,
    );
    if (denial) {
      jsonError(res, denial, 403);
      return true;
    }
    try {
      const room = await resetRoom(
        resolved.namespace,
        parsed.body.name,
        parsed.body.state ?? {},
        parsed.body.schemaVersion,
      );
      roomResetRoute.respond(res, 200, { room });
    } catch (error) {
      sendRoomError(res, error);
    }
    return true;
  }

  if (roomDecodeRoute.match(req.method, pathSegments)) {
    const parsed = await roomDecodeRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    try {
      roomDecodeRoute.respond(res, 200, decodeRoomSnapshot(parsed.body.value));
    } catch (error) {
      sendRoomError(res, error);
    }
    return true;
  }

  return false;
}
