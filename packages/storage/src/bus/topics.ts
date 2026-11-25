export type BusTopics = {
  "script.job.requested": { runId: string; deferredByBootId?: string };
};
export const BUS_TOPICS: Record<keyof BusTopics, "durable" | "ephemeral"> = {
  "script.job.requested": "durable",
};

/** Stable groups let a producer publish before the API consumer starts. */
export const BUS_DURABLE_GROUPS: Record<keyof BusTopics, readonly string[]> = {
  "script.job.requested": ["script-dispatcher"],
};
