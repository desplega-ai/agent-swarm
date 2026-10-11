import { listSubscribedWorkerAgents } from "../realtime/channels";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
import { getTaskById } from "./db/tasks/read";
import { publishWorkerNudge } from "./worker-nudges";

export function startWorkerNudgeListener(): () => void {
  const onTaskCreated = (data: unknown) => {
    if (!isRuntimePoolsEnabled() || listSubscribedWorkerAgents().length === 0) return;
    const taskId = (data as { taskId: string }).taskId;
    void getTaskById(taskId)
      .then((task) => {
        const agentId =
          task?.status === "pending"
            ? task.agentId
            : task?.status === "offered"
              ? task.offeredTo
              : undefined;
        if (agentId) publishWorkerNudge(agentId, { kind: "work", taskId });
      })
      .catch((error) =>
        console.error("[worker-nudges] Task read failed:", scrubSecrets(String(error))),
      );
  };
  workflowEventBus.on("task.created", onTaskCreated);
  return () => workflowEventBus.off("task.created", onTaskCreated);
}
