// Real data, one graph from the position-model benchmark (jev-position-2026-09-18.md,
// task 54961d6c-6a83-4777-9c12-a6ae3cae199b). "6 nodes · seed 20266921" — chosen because
// it's small enough to enumerate by eye AND the decode misses, so the gap beat has
// something real to show. Source: jev-position-2026-09-18-results.json, results[3]
// ("6 nodes · seed 20266921"). Do not touch weights/positions without re-deriving from that file.
export type NodeId = "A" | "C" | "D" | "E" | "F" | "B";

export const nodes: { id: NodeId; x: number; y: number }[] = [
  { id: "A", x: 90, y: 540 },
  { id: "C", x: 310, y: 330 },
  { id: "D", x: 530, y: 540 },
  { id: "F", x: 750, y: 380 },
  { id: "E", x: 750, y: 740 },
  { id: "B", x: 960, y: 540 },
];

export const edges: { from: NodeId; to: NodeId; weight: number }[] = [
  { from: "A", to: "C", weight: 9 },
  { from: "A", to: "D", weight: 1 },
  { from: "A", to: "F", weight: 5 },
  { from: "C", to: "D", weight: 2 },
  { from: "C", to: "E", weight: 8 },
  { from: "C", to: "F", weight: 3 },
  { from: "D", to: "E", weight: 6 },
  { from: "D", to: "F", weight: 3 },
  { from: "D", to: "B", weight: 1 },
  { from: "E", to: "F", weight: 4 },
  { from: "E", to: "B", weight: 3 },
  { from: "F", to: "B", weight: 3 },
];

// Jev's returned per-node position assignment, one call, all six answers at once.
export const jevPositions: Record<NodeId, string> = {
  A: "1",
  C: "out",
  D: "2",
  F: "3",
  E: "out",
  B: "4",
};

export const jevPath: NodeId[] = ["A", "D", "F", "B"];
export const jevWeight = 7;

export const dijkstraPath: NodeId[] = ["A", "D", "B"];
export const dijkstraWeight = 2;

export const excess = jevWeight - dijkstraWeight; // 5

export const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<
  NodeId,
  { id: NodeId; x: number; y: number }
>;

export function pathEdges(path: NodeId[]): [NodeId, NodeId][] {
  const out: [NodeId, NodeId][] = [];
  for (let i = 0; i < path.length - 1; i++) out.push([path[i], path[i + 1]]);
  return out;
}
