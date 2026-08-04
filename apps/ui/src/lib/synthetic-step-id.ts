/**
 * `foreach` nodes fan out one child step per item, and those children carry synthetic node ids of
 * the form `<parentNodeId>#<itemKey>` — ids that do not exist in the workflow definition. New
 * definitions reject `#` in node ids, but workflows created before that rule may legally contain
 * it, so a step id is only treated as synthetic when its prefix names an actual `foreach` node.
 *
 * Returns `itemKey: null` for a regular (non-synthetic) node id.
 *
 * Sibling of the server-side `parseSyntheticNodeId` in `src/workflows/foreach-join.ts`, whose
 * callers all verify the parsed parent against the definition — keep the semantics in sync.
 */
export function parseSyntheticStepId(
  nodeId: string,
  foreachIds: ReadonlySet<string>,
): {
  parentNodeId: string;
  itemKey: string | null;
} {
  const separator = nodeId.indexOf("#");
  if (separator === -1) return { parentNodeId: nodeId, itemKey: null };
  const parentNodeId = nodeId.slice(0, separator);
  if (!foreachIds.has(parentNodeId)) return { parentNodeId: nodeId, itemKey: null };
  return { parentNodeId, itemKey: nodeId.slice(separator + 1) };
}

/** The set of `foreach` node ids in a definition — the only legal synthetic-step parents. */
export function foreachParentIds(
  nodes: ReadonlyArray<{ id: string; type: string }> | undefined,
): Set<string> {
  return new Set((nodes ?? []).filter((node) => node.type === "foreach").map((node) => node.id));
}
