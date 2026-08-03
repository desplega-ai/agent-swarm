/**
 * `foreach` nodes fan out one child step per item, and those children carry synthetic node ids of
 * the form `<parentNodeId>#<itemKey>` — ids that do not exist in the workflow definition. Node ids
 * never contain `#`, so the split happens at the first one.
 *
 * Returns `itemKey: null` for a regular (non-synthetic) node id.
 *
 * Twin of the server-side `parseSyntheticNodeId` in `src/workflows/foreach-join.ts` — keep in sync.
 */
export function parseSyntheticStepId(nodeId: string): {
  parentNodeId: string;
  itemKey: string | null;
} {
  const separator = nodeId.indexOf("#");
  if (separator === -1) return { parentNodeId: nodeId, itemKey: null };
  return { parentNodeId: nodeId.slice(0, separator), itemKey: nodeId.slice(separator + 1) };
}
