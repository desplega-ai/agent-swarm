import * as Y from "yjs";
import * as z from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

const MAX_PATH_DEPTH = 32;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const pathSegmentSchema = z.union([
  z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !UNSAFE_KEYS.has(value), "unsafe path key"),
  z.number().int().nonnegative(),
]);
const pathSchema = z.array(pathSegmentSchema).min(1).max(MAX_PATH_DEPTH);

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_PATH_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(
    ([key, item]) => !UNSAFE_KEYS.has(key) && isJsonValue(item, depth + 1),
  );
}

const jsonValueSchema = z
  .unknown()
  .refine(isJsonValue, "value must be safe JSON") as z.ZodType<JsonValue>;

/**
 * JSON change operations for maps, arrays, numbers, and collaborative text.
 * `set` and `delete` target a path. `insert` targets an array plus an index.
 * `text` edits a string range and stores that value as Y.Text afterward.
 *
 * `increment` reads one finite number and writes its finite sum. Calls through
 * changeRoom apply this read and write synchronously against the live room.
 * Independently authored Yjs number assignments use last-writer-wins semantics.
 */
export const RoomOperationSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("set"), path: pathSchema, value: jsonValueSchema }),
    z.object({ type: z.literal("delete"), path: pathSchema }),
    z.object({
      type: z.literal("insert"),
      path: pathSchema,
      index: z.number().int().nonnegative(),
      values: z.array(jsonValueSchema).min(1),
    }),
    z.object({
      type: z.literal("increment"),
      path: pathSchema,
      by: z.number().finite(),
    }),
    z.object({
      type: z.literal("text"),
      path: pathSchema,
      index: z.number().int().nonnegative(),
      deleteCount: z.number().int().nonnegative().optional(),
      insert: z.string().optional(),
    }),
  ])
  .superRefine((operation, context) => {
    if (
      operation.type === "text" &&
      (operation.deleteCount ?? 0) === 0 &&
      (operation.insert ?? "").length === 0
    ) {
      context.addIssue({ code: "custom", message: "text operation must insert or delete content" });
    }
  });

export type RoomOperation = z.infer<typeof RoomOperationSchema>;

type Container = Y.Map<unknown> | Y.Array<unknown>;

export function createDocument(state: unknown = {}): Y.Doc {
  if (!isJsonValue(state) || state === null || Array.isArray(state) || typeof state !== "object")
    throw new Error("room state must be a safe JSON object");
  const safeState = state as JsonObject;
  const doc = new Y.Doc({ gc: true });
  const root = doc.getMap<unknown>("root");
  doc.transact(() => {
    for (const [key, value] of Object.entries(safeState)) root.set(key, jsonToY(value));
  });
  return doc;
}

function jsonToY(value: JsonValue): unknown {
  if (Array.isArray(value)) {
    const result = new Y.Array<unknown>();
    result.insert(0, value.map(jsonToY));
    return result;
  }
  if (value !== null && typeof value === "object") {
    const result = new Y.Map<unknown>();
    for (const [key, child] of Object.entries(value)) result.set(key, jsonToY(child));
    return result;
  }
  return value;
}

function yToJson(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_PATH_DEPTH) throw new Error("room document exceeds the maximum nesting depth");
  if (value instanceof Y.Map) {
    const result: JsonObject = Object.create(null) as JsonObject;
    for (const [key, child] of value.entries()) {
      if (UNSAFE_KEYS.has(key)) throw new Error(`room document contains unsafe key "${key}"`);
      result[key] = yToJson(child, depth + 1);
    }
    return result;
  }
  if (value instanceof Y.Array) return value.toArray().map((item) => yToJson(item, depth + 1));
  if (value instanceof Y.Text) return value.toString();
  if (!isJsonValue(value)) throw new Error("room document contains a non-JSON value");
  return value;
}

export function materialize(doc: Y.Doc): JsonObject {
  return yToJson(doc.getMap("root")) as JsonObject;
}

function pathLabel(path: ReadonlyArray<string | number>): string {
  return path.map(String).join(".");
}

function validatePath(path: ReadonlyArray<string | number>): void {
  if (path.length === 0 || path.length > MAX_PATH_DEPTH) {
    throw new Error(`room path must contain 1 to ${MAX_PATH_DEPTH} segments`);
  }
  for (const segment of path) {
    if (typeof segment === "string") {
      if (segment.length === 0 || segment.length > 512 || UNSAFE_KEYS.has(segment)) {
        throw new Error(`invalid room path segment "${segment}"`);
      }
    } else if (!Number.isInteger(segment) || segment < 0) {
      throw new Error(`invalid room array index ${String(segment)}`);
    }
  }
}

function childAt(
  container: Container,
  segment: string | number,
  path: readonly unknown[],
): unknown {
  if (container instanceof Y.Map) {
    if (typeof segment !== "string") {
      throw new Error(`expected an object key at "${pathLabel(path as (string | number)[])}"`);
    }
    if (!container.has(segment))
      throw new Error(`room path does not exist: "${pathLabel(path as (string | number)[])}"`);
    return container.get(segment);
  }
  if (typeof segment !== "number" || segment >= container.length) {
    throw new Error(`invalid array index at "${pathLabel(path as (string | number)[])}"`);
  }
  return container.get(segment);
}

function resolveParent(
  doc: Y.Doc,
  path: ReadonlyArray<string | number>,
): { parent: Container; key: string | number } {
  validatePath(path);
  let current: unknown = doc.getMap("root");
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!(current instanceof Y.Map) && !(current instanceof Y.Array)) {
      throw new Error(`room path crosses a scalar at "${pathLabel(path.slice(0, index + 1))}"`);
    }
    current = childAt(current, path[index]!, path.slice(0, index + 1));
  }
  if (!(current instanceof Y.Map) && !(current instanceof Y.Array)) {
    throw new Error(`room path parent is not a container: "${pathLabel(path)}"`);
  }
  return { parent: current, key: path[path.length - 1]! };
}

function getAt(doc: Y.Doc, path: ReadonlyArray<string | number>): unknown {
  const { parent, key } = resolveParent(doc, path);
  return childAt(parent, key, path);
}

function setAt(doc: Y.Doc, path: ReadonlyArray<string | number>, value: JsonValue): void {
  const { parent, key } = resolveParent(doc, path);
  const converted = jsonToY(value);
  if (parent instanceof Y.Map) {
    if (typeof key !== "string") throw new Error(`expected an object key at "${pathLabel(path)}"`);
    parent.set(key, converted);
    return;
  }
  if (typeof key !== "number" || key >= parent.length) {
    throw new Error(`invalid array index at "${pathLabel(path)}"`);
  }
  parent.delete(key, 1);
  parent.insert(key, [converted]);
}

function deleteAt(doc: Y.Doc, path: ReadonlyArray<string | number>): void {
  const { parent, key } = resolveParent(doc, path);
  if (parent instanceof Y.Map) {
    if (typeof key !== "string") throw new Error(`expected an object key at "${pathLabel(path)}"`);
    if (!parent.has(key)) throw new Error(`room path does not exist: "${pathLabel(path)}"`);
    parent.delete(key);
    return;
  }
  if (typeof key !== "number" || key >= parent.length) {
    throw new Error(`invalid array index at "${pathLabel(path)}"`);
  }
  parent.delete(key, 1);
}

function applyUnchecked(doc: Y.Doc, operations: readonly RoomOperation[]): void {
  doc.transact(() => {
    for (const operation of operations) {
      switch (operation.type) {
        case "set":
          setAt(doc, operation.path, operation.value);
          break;
        case "delete":
          deleteAt(doc, operation.path);
          break;
        case "insert": {
          validatePath(operation.path);
          const target = getAt(doc, operation.path);
          if (!(target instanceof Y.Array)) {
            throw new Error(`insert target is not an array: "${pathLabel(operation.path)}"`);
          }
          if (operation.index > target.length) {
            throw new Error(`insert index is outside the array: "${pathLabel(operation.path)}"`);
          }
          target.insert(operation.index, operation.values.map(jsonToY));
          break;
        }
        case "increment": {
          const current = getAt(doc, operation.path);
          if (typeof current !== "number" || !Number.isFinite(current)) {
            throw new Error(
              `increment target is not a finite number: "${pathLabel(operation.path)}"`,
            );
          }
          const next = current + operation.by;
          if (!Number.isFinite(next)) {
            throw new Error(`increment result is not finite: "${pathLabel(operation.path)}"`);
          }
          setAt(doc, operation.path, next);
          break;
        }
        case "text": {
          const existing = getAt(doc, operation.path);
          let text: Y.Text;
          if (existing instanceof Y.Text) {
            text = existing;
          } else if (typeof existing === "string") {
            text = new Y.Text(existing);
            const { parent, key } = resolveParent(doc, operation.path);
            if (parent instanceof Y.Map && typeof key === "string") parent.set(key, text);
            else if (parent instanceof Y.Array && typeof key === "number" && key < parent.length) {
              parent.delete(key, 1);
              parent.insert(key, [text]);
            } else {
              throw new Error(`invalid text path: "${pathLabel(operation.path)}"`);
            }
          } else {
            throw new Error(`text target is not a string: "${pathLabel(operation.path)}"`);
          }
          const deleteCount = operation.deleteCount ?? 0;
          if (operation.index > text.length || operation.index + deleteCount > text.length) {
            throw new Error(`text range is outside the string: "${pathLabel(operation.path)}"`);
          }
          if (deleteCount > 0) text.delete(operation.index, deleteCount);
          if (operation.insert) text.insert(operation.index, operation.insert);
          break;
        }
      }
    }
  });
}

/** Apply a batch atomically. Invalid operations leave the source document unchanged. */
export function applyOperations(doc: Y.Doc, operations: readonly RoomOperation[]): Uint8Array {
  const parsed = z.array(RoomOperationSchema).min(1).parse(operations);
  const candidate = new Y.Doc({ gc: true });
  try {
    Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
    applyUnchecked(candidate, parsed);
    materialize(candidate);
  } finally {
    candidate.destroy();
  }
  const before = Y.encodeStateVector(doc);
  applyUnchecked(doc, parsed);
  return Y.encodeStateAsUpdate(doc, before);
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]!))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && equalJson(left[key]!, right[key]!))
  );
}

function alignedArrayItem(left: JsonValue, right: JsonValue): boolean {
  if (equalJson(left, right)) return true;
  if (
    left !== null &&
    right !== null &&
    !Array.isArray(left) &&
    !Array.isArray(right) &&
    typeof left === "object" &&
    typeof right === "object" &&
    Object.hasOwn(left, "id") &&
    Object.hasOwn(right, "id")
  ) {
    const leftId = left.id;
    return (
      (typeof leftId === "string" || typeof leftId === "number") && Object.is(leftId, right.id)
    );
  }
  return false;
}

function arrayIdentity(value: JsonValue): string {
  if (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    (typeof value.id === "string" || typeof value.id === "number")
  ) {
    return `id:${typeof value.id}:${String(value.id)}`;
  }
  return `value:${JSON.stringify(value)}`;
}

function keyedArrayOrder(values: JsonValue[]): string[] | null {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      (typeof value.id !== "string" && typeof value.id !== "number")
    ) {
      return null;
    }
    const identity = arrayIdentity(value);
    if (seen.has(identity)) return null;
    seen.add(identity);
    order.push(identity);
  }
  return order;
}

function alignedArrayPairs(before: JsonValue[], after: JsonValue[]): Array<[number, number]> {
  const positions = new Map<string, number[]>();
  for (let index = 0; index < after.length; index += 1) {
    const identity = arrayIdentity(after[index]!);
    const indexes = positions.get(identity);
    if (indexes) indexes.push(index);
    else positions.set(identity, [index]);
  }
  const pairs: Array<[number, number]> = [];
  let lastAfter = -1;
  for (let beforeIndex = 0; beforeIndex < before.length; beforeIndex += 1) {
    const indexes = positions.get(arrayIdentity(before[beforeIndex]!));
    while (indexes?.length && indexes[0]! <= lastAfter) indexes.shift();
    const afterIndex = indexes?.shift();
    if (afterIndex === undefined) continue;
    if (!alignedArrayItem(before[beforeIndex]!, after[afterIndex]!)) continue;
    pairs.push([beforeIndex, afterIndex]);
    lastAfter = afterIndex;
  }
  return pairs;
}

function currentYValue(doc: Y.Doc, path: ReadonlyArray<string | number>): unknown {
  try {
    return getAt(doc, path);
  } catch {
    return undefined;
  }
}

function diffJson(
  doc: Y.Doc,
  before: JsonValue,
  after: JsonValue,
  path: Array<string | number>,
  operations: RoomOperation[],
): void {
  if (equalJson(before, after)) return;
  if (
    before !== null &&
    after !== null &&
    !Array.isArray(before) &&
    !Array.isArray(after) &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) operations.push({ type: "delete", path: [...path, key] });
    }
    for (const [key, value] of Object.entries(after)) {
      if (!Object.hasOwn(before, key))
        operations.push({ type: "set", path: [...path, key], value });
      else diffJson(doc, before[key]!, value, [...path, key], operations);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const beforeOrder = keyedArrayOrder(before);
    const afterOrder = keyedArrayOrder(after);
    const keyedOrderChanged =
      beforeOrder !== null &&
      afterOrder !== null &&
      (beforeOrder.length !== afterOrder.length ||
        beforeOrder.some((identity, index) => identity !== afterOrder[index]));
    if (before.length === after.length && !keyedOrderChanged) {
      for (let index = 0; index < after.length; index += 1) {
        diffJson(doc, before[index]!, after[index]!, [...path, index], operations);
      }
      return;
    }
    let beforeCursor = 0;
    let afterCursor = 0;
    let liveIndex = 0;
    for (const [beforeIndex, afterIndex] of [
      ...alignedArrayPairs(before, after),
      [before.length, after.length] as [number, number],
    ]) {
      const removed = beforeIndex - beforeCursor;
      for (let index = 0; index < removed; index += 1) {
        operations.push({ type: "delete", path: [...path, liveIndex] });
      }
      const inserted = after.slice(afterCursor, afterIndex);
      if (inserted.length > 0) {
        operations.push({ type: "insert", path, index: liveIndex, values: inserted });
        liveIndex += inserted.length;
      }
      if (beforeIndex < before.length && afterIndex < after.length) {
        diffJson(doc, before[beforeIndex]!, after[afterIndex]!, [...path, liveIndex], operations);
        liveIndex += 1;
      }
      beforeCursor = beforeIndex + 1;
      afterCursor = afterIndex + 1;
    }
    return;
  }
  if (
    typeof before === "string" &&
    typeof after === "string" &&
    currentYValue(doc, path) instanceof Y.Text
  ) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
      prefix += 1;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    operations.push({
      type: "text",
      path,
      index: prefix,
      deleteCount: before.length - prefix - suffix,
      insert: after.slice(prefix, after.length - suffix),
    });
    return;
  }
  operations.push({ type: "set", path, value: after });
}

/**
 * Run a plain-object mutation callback and apply its precise nested changes.
 * Numeric assignments are Yjs last-writer-wins values. Use `increment` when
 * callers need an atomic read-modify-write against the live server document.
 */
export function changeDocument(doc: Y.Doc, change: (state: JsonObject) => void): RoomOperation[] {
  const before = materialize(doc);
  const draft = structuredClone(before);
  const result: unknown = change(draft);
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    typeof (result as { then?: unknown }).then === "function"
  ) {
    throw new Error("room change callback must be synchronous");
  }
  if (!isJsonValue(draft) || Array.isArray(draft))
    throw new Error("room state must be a safe JSON object");
  const operations: RoomOperation[] = [];
  diffJson(doc, before, draft, [], operations);
  if (operations.length > 0) applyOperations(doc, operations);
  return operations;
}

export { Y };
