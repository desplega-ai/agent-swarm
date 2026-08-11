import type { DevFlowState } from "./types";

export const SLICE_ONE_TRANSITIONS: Readonly<Partial<Record<DevFlowState, readonly DevFlowState[]>>> = {
  captured: ["triaged", "archived"],
  triaged: ["scoped", "archived"],
  scoped: ["specced", "blocked", "archived"],
  specced: ["blocked", "archived"],
  sized: ["blocked", "archived"],
  planned: ["blocked", "archived"],
  building: ["blocked", "archived"],
  in_review: ["archived"],
  deployed: ["archived"],
  monitoring: ["archived"],
  blocked: [],
  done: [],
  archived: [],
};

export const DISABLED_FORWARD_TRANSITIONS = new Set([
  "specced:sized",
  "sized:planned",
  "planned:building",
  "building:in_review",
  "in_review:deployed",
  "deployed:monitoring",
  "monitoring:done",
]);

export function isSliceOneTransition(from: DevFlowState, to: DevFlowState): boolean {
  return SLICE_ONE_TRANSITIONS[from]?.includes(to) ?? false;
}
