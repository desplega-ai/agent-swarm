import {
  createObject,
  getObject,
  listObjects,
  ObjectsError,
  type PrimitiveObject,
} from "../objects";
import { mutateObject } from "../write-object";
import {
  type ArrowInput,
  addElements,
  type BoardElement,
  type ElementPatch,
  type ElementSummary,
  type Layout,
  parseScene,
  removeElements,
  type ShapeInput,
  summarize,
  updateElements,
} from "./elements";

/** Boards: `.excalidraw` objects edited as raw element JSON (ctx.boards, board-* tools). */

type Ref = { agentId: string | undefined; id?: string; path?: string };

const ref = (input: Ref) => {
  if (!input.id && !input.path) throw new ObjectsError("pass `id` or `path`");
  return { agentId: input.agentId, id: input.id, path: input.path, kind: "board" };
};

export async function createBoard(input: {
  agentId: string | undefined;
  path: string;
  title?: string;
  shapes?: ShapeInput[];
  arrows?: ArrowInput[];
  layout?: Layout;
}): Promise<{ object: PrimitiveObject; added: Record<string, string> }> {
  let added: Record<string, string> = {};
  const object = await createObject({
    agentId: input.agentId,
    kind: "board",
    path: input.path,
    title: input.title,
    build: (empty) => {
      added = addElements(parseScene(empty, input.path), input);
      return empty;
    },
  });
  return { object, added };
}

export async function getBoard(input: Ref & { detail?: "summary" | "full" }): Promise<{
  object: PrimitiveObject;
  version: number | null;
  elements: ElementSummary[] | BoardElement[];
}> {
  const { object, missing, content } = await getObject({ ...ref(input), includeContent: true });
  if (object.kind !== "board")
    throw new ObjectsError(`object ${object.id} is a ${object.kind}, not a board`);
  if (missing) {
    throw new ObjectsError(
      `the file for board ${object.id} at '${object.path}' is missing; run object-reindex`,
    );
  }
  const scene = parseScene(content, object.path);
  return {
    object,
    version: object.fileVersion,
    elements:
      input.detail === "full" ? scene.elements.filter((e) => !e.isDeleted) : summarize(scene),
  };
}

export function listBoards(input: {
  agentId: string | undefined;
  prefix?: string;
  limit?: number;
  offset?: number;
}) {
  return listObjects({ ...input, kind: "board" });
}

export async function addBoardElements(
  input: Ref & { shapes?: ShapeInput[]; arrows?: ArrowInput[]; layout?: Layout },
): Promise<{ object: PrimitiveObject; version: number | null; added: Record<string, string> }> {
  if (!input.shapes?.length && !input.arrows?.length) {
    throw new ObjectsError("pass at least one shape or arrow");
  }
  const { object, version, result } = await mutateObject({
    ...ref(input),
    message: "add board elements",
    mutate: (content, o) => addElements(parseScene(content, o.path), input),
  });
  return { object, version, added: result };
}

export async function updateBoardElements(
  input: Ref & { patches: ElementPatch[] },
): Promise<{ object: PrimitiveObject; version: number | null; updated: string[] }> {
  if (input.patches.length === 0) throw new ObjectsError("pass at least one patch");
  const { object, version, result } = await mutateObject({
    ...ref(input),
    message: "update board elements",
    mutate: (content, o) => updateElements(parseScene(content, o.path), input.patches),
  });
  return { object, version, updated: result };
}

export async function removeBoardElements(
  input: Ref & { elementIds: string[] },
): Promise<{ object: PrimitiveObject; version: number | null; removed: string[] }> {
  if (input.elementIds.length === 0) throw new ObjectsError("pass at least one element id");
  const { object, version, result } = await mutateObject({
    ...ref(input),
    message: "remove board elements",
    mutate: (content, o) => removeElements(parseScene(content, o.path), input.elementIds),
  });
  return { object, version, removed: result };
}
