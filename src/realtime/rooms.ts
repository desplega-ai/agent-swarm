import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { getDbClient } from "../be/db";
import { scrubSecrets } from "../utils/secret-scrubber";
import { realtimeBus } from "./bus";
import {
  applyOperations,
  createDocument,
  type JsonObject,
  materialize,
  type RoomOperation,
} from "./document";

const ROOM_KEY_PREFIX = "_room/";
const ROOM_FORMAT = "swarm-room-v1";
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAX_ROOMS_PER_NAMESPACE = 100;
const MAX_ACTIVE_ROOMS = 1_000;
const FLUSH_DELAY_MS = 1_000;
const WORKFLOW_DEBOUNCE_MS = 100;
const IDLE_ROOM_MS = 5 * 60_000;

type RoomEnvelope = {
  format: typeof ROOM_FORMAT;
  schemaVersion: number;
  generation: string;
  snapshot: string;
};

export type RoomView = {
  namespace: string;
  name: string;
  schemaVersion: number;
  generation: string;
  stale: boolean;
  state: JsonObject;
  snapshot: string;
  bytes: number;
};

export type LiveRoom = {
  doc: Y.Doc;
  awareness: Awareness;
  namespace: string;
  name: string;
  schemaVersion: number;
  generation: string;
  lastActivity: number;
};

type ManagedRoom = LiveRoom & {
  dirtyVersion: number;
  persistedVersion: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  workflowTimer?: ReturnType<typeof setTimeout>;
  updateListener: (update: Uint8Array, origin: unknown) => void;
};

type RoomsState = {
  rooms: Map<string, ManagedRoom>;
  pending: Map<string, Promise<ManagedRoom>>;
  creationChain: Promise<void>;
  namespaceEpoch: Map<string, number>;
};

const globals = globalThis as typeof globalThis & { __swarmRoomsState?: RoomsState };
if (!globals.__swarmRoomsState) {
  globals.__swarmRoomsState = {
    rooms: new Map(),
    pending: new Map(),
    creationChain: Promise.resolve(),
    namespaceEpoch: new Map(),
  };
}
const state = globals.__swarmRoomsState;
state.namespaceEpoch ??= new Map();

function roomId(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`;
}

function roomKey(name: string): string {
  return `${ROOM_KEY_PREFIX}${name}`;
}

function validateRoomAddress(namespace: string, name: string, schemaVersion: number): void {
  if (!/^[a-zA-Z0-9._:/-]{1,512}$/.test(namespace)) {
    throw new Error("room namespace is invalid");
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error("room name must use 1 to 64 letters, numbers, underscores, or hyphens");
  }
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error("room schemaVersion must be a positive safe integer");
  }
}

export function roomTopic(namespace: string, name: string): string {
  return `room:${namespace}:${name}`;
}

function pageIdForNamespace(namespace: string): string | undefined {
  const prefix = "task:page:";
  return namespace.startsWith(prefix) && namespace.length > prefix.length
    ? namespace.slice(prefix.length)
    : undefined;
}

function parseEnvelope(value: unknown): RoomEnvelope {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as Partial<RoomEnvelope>).format !== ROOM_FORMAT ||
    !Number.isSafeInteger((parsed as Partial<RoomEnvelope>).schemaVersion) ||
    ((parsed as Partial<RoomEnvelope>).schemaVersion ?? 0) < 1 ||
    typeof (parsed as Partial<RoomEnvelope>).generation !== "string" ||
    !(parsed as Partial<RoomEnvelope>).generation ||
    typeof (parsed as Partial<RoomEnvelope>).snapshot !== "string"
  ) {
    throw new Error("stored room snapshot has an invalid envelope");
  }
  return parsed as RoomEnvelope;
}

function envelopeFor(doc: Y.Doc, schemaVersion: number, generation: string): RoomEnvelope {
  return {
    format: ROOM_FORMAT,
    schemaVersion,
    generation,
    snapshot: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64"),
  };
}

function envelopeBytes(envelope: RoomEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

function assertEnvelopeSize(doc: Y.Doc, schemaVersion: number, generation: string): void {
  const bytes = envelopeBytes(envelopeFor(doc, schemaVersion, generation));
  if (bytes > MAX_ENVELOPE_BYTES) {
    throw new Error(
      `room snapshot is ${bytes} bytes and exceeds the ${MAX_ENVELOPE_BYTES}-byte limit`,
    );
  }
}

function docFromEnvelope(envelope: RoomEnvelope): Y.Doc {
  const doc = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(doc, Uint8Array.from(Buffer.from(envelope.snapshot, "base64")));
    validateDocument(doc);
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

function validateDocument(doc: Y.Doc): void {
  for (const key of doc.share.keys()) {
    if (key !== "root") throw new Error(`room update contains unsupported shared type "${key}"`);
  }
  materialize(doc);
}

export function decodeRoomSnapshot(value: unknown): {
  schemaVersion: number;
  generation: string;
  state: JsonObject;
} {
  const envelope = parseEnvelope(value);
  if (envelopeBytes(envelope) > MAX_ENVELOPE_BYTES)
    throw new Error("room snapshot exceeds the size limit");
  const doc = docFromEnvelope(envelope);
  try {
    return {
      schemaVersion: envelope.schemaVersion,
      generation: envelope.generation,
      state: materialize(doc),
    };
  } finally {
    doc.destroy();
  }
}

export function roomView(room: LiveRoom, requestedVersion = room.schemaVersion): RoomView {
  const envelope = envelopeFor(room.doc, room.schemaVersion, room.generation);
  return {
    namespace: room.namespace,
    name: room.name,
    schemaVersion: room.schemaVersion,
    generation: room.generation,
    stale: requestedVersion !== room.schemaVersion,
    state: materialize(room.doc),
    snapshot: envelope.snapshot,
    bytes: envelopeBytes(envelope),
  };
}

function logRoomError(label: string, error: unknown): void {
  const message = scrubSecrets(error instanceof Error ? error.message : String(error));
  console.error(`[rooms] ${label}: ${message}`);
}

function publishRoom(room: ManagedRoom, type: "update" | "reset" | "deleted"): void {
  const view = roomView(room);
  try {
    realtimeBus.publish(roomTopic(room.namespace, room.name), { type, ...view });
  } catch (error) {
    logRoomError(`failed to publish ${type} for ${room.namespace}/${room.name}`, error);
  }
  if (type === "deleted") return;
  if (room.workflowTimer) return;
  room.workflowTimer = setTimeout(() => {
    room.workflowTimer = undefined;
    const pageId = pageIdForNamespace(room.namespace);
    try {
      realtimeBus.publish("workflow:room.changed", {
        namespace: room.namespace,
        room: room.name,
        ...(pageId ? { page: pageId } : {}),
        generation: room.generation,
        schemaVersion: room.schemaVersion,
      });
    } catch (error) {
      logRoomError(`failed to publish workflow event for ${room.namespace}/${room.name}`, error);
    }
  }, WORKFLOW_DEBOUNCE_MS);
  room.workflowTimer.unref?.();
}

function scheduleFlush(room: ManagedRoom): void {
  if (room.flushTimer) return;
  room.flushTimer = setTimeout(() => {
    room.flushTimer = undefined;
    void flushRoom(room);
  }, FLUSH_DELAY_MS);
  room.flushTimer.unref?.();
}

function markChanged(room: ManagedRoom): void {
  room.lastActivity = Date.now();
  room.dirtyVersion += 1;
  scheduleFlush(room);
  publishRoom(room, "update");
}

function attachRoom(
  namespace: string,
  name: string,
  doc: Y.Doc,
  schemaVersion: number,
  generation: string,
  persisted: boolean,
): ManagedRoom {
  const room = {
    namespace,
    name,
    doc,
    awareness: new Awareness(doc),
    schemaVersion,
    generation,
    lastActivity: Date.now(),
    dirtyVersion: persisted ? 0 : 1,
    persistedVersion: 0,
    updateListener: (_update: Uint8Array, _origin: unknown): void => {},
  } satisfies ManagedRoom;
  room.awareness.setLocalState(null);
  room.updateListener = (_update: Uint8Array, origin: unknown) => {
    if (origin === room) return;
    markChanged(room);
  };
  doc.on("update", room.updateListener);
  if (!persisted) scheduleFlush(room);
  return room;
}

function withCreationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = state.creationChain.catch(() => undefined).then(operation);
  state.creationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function loadRoom(
  namespace: string,
  name: string,
  schemaVersion: number,
  create: boolean,
): Promise<ManagedRoom> {
  if (state.rooms.size >= MAX_ACTIVE_ROOMS) {
    throw new Error(`server has reached its ${MAX_ACTIVE_ROOMS}-active-room limit`);
  }
  const client = getDbClient();
  return await client.transaction(
    async (tx) => {
      const pageId = pageIdForNamespace(namespace);
      if (pageId) {
        const page = await tx.get<{ present: number }>(
          "SELECT 1 AS present FROM pages WHERE id = ?",
          [pageId],
        );
        if (!page) throw new Error("page room owner does not exist");
      }

      const persisted = await tx.get<{ value: string; value_type: string }>(
        "SELECT value, value_type FROM kv_entries WHERE namespace = ? AND key = ?",
        [namespace, roomKey(name)],
      );
      if (persisted) {
        if (persisted.value_type !== "json") throw new Error("stored room snapshot is not JSON");
        const envelope = parseEnvelope(persisted.value);
        if (envelopeBytes(envelope) > MAX_ENVELOPE_BYTES) {
          throw new Error("stored room snapshot exceeds the size limit");
        }
        return attachRoom(
          namespace,
          name,
          docFromEnvelope(envelope),
          envelope.schemaVersion,
          envelope.generation,
          true,
        );
      }

      if (!create) throw new Error("room does not exist");

      const persistedRows = await tx.query<{ key: string }>(
        "SELECT key FROM kv_entries WHERE namespace = ? AND key LIKE '\\_room/%' ESCAPE '\\'",
        [namespace],
      );
      const names = new Set(persistedRows.map((row) => row.key.slice(ROOM_KEY_PREFIX.length)));
      for (const room of state.rooms.values()) {
        if (room.namespace === namespace) names.add(room.name);
      }
      if (names.size >= MAX_ROOMS_PER_NAMESPACE) {
        throw new Error(`room namespace has reached its ${MAX_ROOMS_PER_NAMESPACE}-room limit`);
      }
      return attachRoom(
        namespace,
        name,
        createDocument(),
        schemaVersion,
        crypto.randomUUID(),
        false,
      );
    },
    { readOnly: true },
  );
}

export async function getRoom(
  namespace: string,
  name: string,
  schemaVersion = 1,
  options: { create?: boolean } = {},
): Promise<LiveRoom> {
  validateRoomAddress(namespace, name, schemaVersion);
  const id = roomId(namespace, name);
  const existing = state.rooms.get(id);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing;
  }
  const create = options.create !== false;
  const pendingId = `${id}\u0000${create ? "create" : "read"}`;
  const pending = state.pending.get(pendingId);
  if (pending) return await pending;
  const namespaceEpoch = state.namespaceEpoch.get(namespace) ?? 0;
  const loading = withCreationLock(async () => {
    const raced = state.rooms.get(id);
    if (raced) return raced;
    const room = await loadRoom(namespace, name, schemaVersion, create);
    if ((state.namespaceEpoch.get(namespace) ?? 0) !== namespaceEpoch) {
      destroyRoom(room);
      throw new Error("room namespace was removed during room creation");
    }
    state.rooms.set(id, room);
    return room;
  });
  state.pending.set(pendingId, loading);
  try {
    return await loading;
  } finally {
    if (state.pending.get(pendingId) === loading) state.pending.delete(pendingId);
  }
}

function requireWritable(room: LiveRoom, schemaVersion: number): asserts room is ManagedRoom {
  if (room.schemaVersion !== schemaVersion) {
    throw new Error(
      `room schema version ${room.schemaVersion} does not match requested version ${schemaVersion}`,
    );
  }
  if (state.rooms.get(roomId(room.namespace, room.name)) !== room) {
    throw new Error("room generation is no longer active");
  }
}

export async function changeRoom(
  namespace: string,
  name: string,
  operations: readonly RoomOperation[],
  schemaVersion = 1,
): Promise<RoomView> {
  const room = await getRoom(namespace, name, schemaVersion);
  requireWritable(room, schemaVersion);
  const candidate = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
    applyOperations(candidate, operations);
    assertEnvelopeSize(candidate, room.schemaVersion, room.generation);
  } finally {
    candidate.destroy();
  }
  applyOperations(room.doc, operations);
  return roomView(room);
}

export async function applyRoomUpdate(
  room: LiveRoom,
  update: Uint8Array,
  generation: string,
  schemaVersion: number,
): Promise<RoomView> {
  requireWritable(room, schemaVersion);
  if (room.generation !== generation) throw new Error("room generation does not match");
  const candidate = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(room.doc));
    Y.applyUpdate(candidate, update);
    validateDocument(candidate);
    assertEnvelopeSize(candidate, room.schemaVersion, room.generation);
  } finally {
    candidate.destroy();
  }
  Y.applyUpdate(room.doc, update);
  room.lastActivity = Date.now();
  return roomView(room);
}

export async function resetRoom(
  namespace: string,
  name: string,
  roomState: unknown,
  schemaVersion = 1,
): Promise<RoomView> {
  validateRoomAddress(namespace, name, schemaVersion);
  await getRoom(namespace, name, schemaVersion);
  const id = roomId(namespace, name);
  const previous = state.rooms.get(id);
  if (!previous) throw new Error("room is not active");
  const doc = createDocument(roomState);
  const generation = crypto.randomUUID();
  try {
    assertEnvelopeSize(doc, schemaVersion, generation);
  } catch (error) {
    doc.destroy();
    throw error;
  }
  const room = attachRoom(namespace, name, doc, schemaVersion, generation, false);
  state.rooms.set(id, room);
  destroyRoom(previous);
  publishRoom(room, "reset");
  return roomView(room);
}

async function flushRoom(room: ManagedRoom): Promise<boolean> {
  if (room.dirtyVersion === room.persistedVersion) return true;
  const version = room.dirtyVersion;
  try {
    const envelope = envelopeFor(room.doc, room.schemaVersion, room.generation);
    const encoded = JSON.stringify(envelope);
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > MAX_ENVELOPE_BYTES) {
      throw new Error(
        `room snapshot is ${bytes} bytes and exceeds the ${MAX_ENVELOPE_BYTES}-byte limit`,
      );
    }
    const client = getDbClient();
    await client.transaction(async (tx) => {
      const pageId = pageIdForNamespace(room.namespace);
      if (pageId) {
        const page = await tx.get<{ present: number }>(
          "SELECT 1 AS present FROM pages WHERE id = ?",
          [pageId],
        );
        if (!page) throw new Error("page room owner was deleted before snapshot flush");
      }
      if (state.rooms.get(roomId(room.namespace, room.name)) !== room) {
        throw new Error("room generation changed before snapshot flush");
      }
      const now = Date.now();
      await tx.run(
        `INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, 'json', NULL, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           value_type = excluded.value_type,
           expires_at = NULL,
           updated_at = excluded.updated_at`,
        [room.namespace, roomKey(room.name), encoded, now, now],
      );
    });
    room.persistedVersion = version;
    if (
      room.dirtyVersion !== room.persistedVersion &&
      state.rooms.get(roomId(room.namespace, room.name)) === room
    ) {
      scheduleFlush(room);
    }
    return true;
  } catch (error) {
    logRoomError(`failed to flush ${room.namespace}/${room.name}`, error);
    if (state.rooms.get(roomId(room.namespace, room.name)) === room) scheduleFlush(room);
    return false;
  }
}

export async function flushRooms(): Promise<void> {
  await Promise.all([...state.rooms.values()].map((room) => flushRoom(room)));
}

function destroyRoom(room: ManagedRoom): void {
  if (room.flushTimer) clearTimeout(room.flushTimer);
  if (room.workflowTimer) clearTimeout(room.workflowTimer);
  room.doc.off("update", room.updateListener);
  room.awareness.destroy();
  room.doc.destroy();
}

export async function sweepRooms(now = Date.now()): Promise<number> {
  let evicted = 0;
  for (const [id, room] of state.rooms) {
    if (now - room.lastActivity < IDLE_ROOM_MS) continue;
    if (room.awareness.getStates().size > 0) continue;
    if (realtimeBus.subscriberCount(roomTopic(room.namespace, room.name)) > 0) continue;
    await flushRoom(room);
    if (room.dirtyVersion !== room.persistedVersion) continue;
    if (state.rooms.get(id) !== room) continue;
    if (now - room.lastActivity < IDLE_ROOM_MS) continue;
    if (room.awareness.getStates().size > 0) continue;
    if (realtimeBus.subscriberCount(roomTopic(room.namespace, room.name)) > 0) continue;
    state.rooms.delete(id);
    destroyRoom(room);
    evicted += 1;
  }
  return evicted;
}

export async function closeRooms(): Promise<void> {
  await flushRooms();
  const unsaved = [...state.rooms.values()].filter(
    (room) => room.dirtyVersion !== room.persistedVersion,
  );
  if (unsaved.length > 0) {
    throw new Error(`failed to flush ${unsaved.length} room snapshot(s) before shutdown`);
  }
  for (const room of state.rooms.values()) destroyRoom(room);
  state.rooms.clear();
  state.pending.clear();
}

export function removeNamespaceRooms(namespace: string): void {
  state.namespaceEpoch.set(namespace, (state.namespaceEpoch.get(namespace) ?? 0) + 1);
  for (const [id, room] of state.rooms) {
    if (room.namespace !== namespace) continue;
    state.rooms.delete(id);
    publishRoom(room, "deleted");
    destroyRoom(room);
  }
}
