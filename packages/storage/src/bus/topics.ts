export type BusTopics = {
  "workflow.step_job.requested": {jobId:string};
  "workflow.step_job.finished": {jobId:string;runId:string};
  "script.job.requested": { runId: string; deferredByBootId?: string };
};
export const BUS_TOPICS: Record<keyof BusTopics, "durable" | "ephemeral"> = {
  "workflow.step_job.requested": "durable",
  "workflow.step_job.finished": "durable",
  "script.job.requested": "durable",
};

/** Stable groups let a producer publish before the API consumer starts. */
export type BusDurableGroups = Readonly<Record<keyof BusTopics, readonly string[]>>;
export const BUS_DURABLE_GROUPS: BusDurableGroups = {
  "workflow.step_job.requested": ["workflow-step-dispatcher"],
  "workflow.step_job.finished": ["workflow-resume"],
  "script.job.requested": ["script-dispatcher"],
};
