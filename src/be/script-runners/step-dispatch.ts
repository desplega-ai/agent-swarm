import type { WorkflowStepJob } from "@desplega/storage";
import { encodeRunnerFrame } from "../../script-runner/protocol";
import {
  adoptHeldScriptSlot,
  reserveHeldScriptRunner,
} from "../../scripts-runtime/dispatch/held-reservations";
import type { ExecutorOutput } from "../../scripts-runtime/executors/types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { checkpointStepFailure } from "../../workflows/checkpoint";
import { getSuccessors } from "../../workflows/definition";
import { interpolateNodeConfig, walkGraph } from "../../workflows/engine";
import type { ExecutorRegistry } from "../../workflows/executors/registry";
import { resolveStepNode } from "../../workflows/foreach-body";
import { runForeachDrive } from "../../workflows/foreach-driver";
import { resolveForeachParent, settleForeachChild } from "../../workflows/foreach-join";
import { getSecretInputKeys } from "../../workflows/input";
import { finalizeOrWait } from "../../workflows/resume";
import { rebuildNodeExecutionInput } from "../../workflows/step-input";
import { getStepJobKind, type PreparedStepJob } from "../../workflows/step-job-kinds";
import { settleStepResult } from "../../workflows/step-settle";
import {
  getLatestStepForNode,
  getRunWorkflow,
  getWorkflowRun,
  getWorkflowRunStep,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../db";
import { getRunLineageBlock } from "../db/workflow-runs";
import { getStorage } from "../storage";
import { type RemoteScriptRunner, registerHeldStepHooks, scriptRunnerSessions } from "./sessions";

const LEASE_MS = 60000;
const active = new Map<
  string,
  { prepared: PreparedStepJob; releaseSlot: () => void; controller: AbortController; owner: string }
>();
const adoptedSlots = new Map<string, () => void>();
let draining = false;
let registry: ExecutorRegistry;
let timer: ReturnType<typeof setInterval> | undefined;
const subscriptions: (() => void)[] = [];
const send = (runner: RemoteScriptRunner, message: unknown) =>
  runner.socket.send(encodeRunnerFrame(message));

async function load(job: WorkflowStepJob) {
  const run = await getWorkflowRun(job.runId);
  const step = await getWorkflowRunStep(job.stepId);
  if (!run || !step) throw new Error("Workflow job has no run or step");
  const workflow = await getRunWorkflow(run);
  if (!workflow) throw new Error("Workflow job has no pinned definition");
  const node = resolveStepNode(workflow.definition, step.nodeId);
  if (!node) throw new Error("Workflow job has no node");
  const parent = resolveForeachParent(workflow.definition, step.nodeId);
  const execution = await rebuildNodeExecutionInput(
    workflow.definition,
    run,
    parent ?? node,
    registry,
  );
  let inputCtx = execution.inputCtx;
  let config = execution.config;
  if (parent) {
    const items = execution.config.over as Record<string, unknown>[];
    const saved = step.input as { itemKey: string; index: number };
    const item = items.find((item) => item[String(execution.config.itemKey)] === saved.itemKey);
    if (!item) throw new Error("Workflow job item no longer exists");
    inputCtx = { ...inputCtx, item, index: saved.index };
    config = interpolateNodeConfig(node, inputCtx).value as Record<string, unknown>;
  }
  return {
    run,
    step,
    workflow,
    node,
    parent,
    ctx: execution.ctx,
    config,
    inputCtx,
    build: {
      job,
      node,
      config,
      context: execution.ctx,
      meta: {
        runId: run.id,
        stepId: step.id,
        nodeId: step.nodeId,
        workflowId: workflow.id,
        dryRun: false,
        inputCtx,
      },
    },
  };
}

async function release(id: string) {
  adoptedSlots.get(id)?.();
  adoptedSlots.delete(id);
  const held = active.get(id);
  active.delete(id);
  if (held) {
    try {
      held.controller.abort();
      await held.prepared.release();
    } finally {
      held.releaseSlot();
    }
  }
}

export async function settleWorkflowStepJob(
  id: string,
  owner: string,
  raw: ExecutorOutput,
  acknowledge?: () => void,
): Promise<void> {
  const storage = getStorage();
  const job = await storage.repos.workflowStepJobs.get(id);
  if (!job) return;
  let prepared = active.get(id)?.prepared;
  try {
    if (
      job.status !== "running" ||
      job.ownerId !== owner ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= new Date().toISOString()
    )
      return;
    const data = await load(job);
    // Rebuild the scrubber after API restart. Source and secrets remain API-owned.
    prepared ??= await getStepJobKind(job.kind).build(data.build);
    const result = await prepared.finish(raw);
    await storage.transaction(async () => {
      if (await getRunLineageBlock(job.runId)) return;
      if (
        !(await storage.repos.workflowStepJobs.settle(
          id,
          owner,
          new Date().toISOString(),
          result.status === "failed" ? "failed" : "completed",
          result.error ? scrubSecrets(result.error).slice(0, 4096) : null,
        ))
      )
        return;
      await storage.repos.workflowStepJobs.revokeStepCredentials(
        job.stepId,
        new Date().toISOString(),
      );
      const current = await getWorkflowRunStep(job.stepId);
      if (current?.status !== "waiting" || current.retryCount !== job.attempt)
        throw new Error("Workflow job lost its step attempt");
      if (data.parent) {
        await settleForeachChild(
          data.workflow.definition,
          job.runId,
          job.stepId,
          {
            status: result.status === "failed" ? "failed" : "completed",
            output: result.output,
            error: result.error,
            nextPort: result.nextPort,
          },
          data.ctx,
          { registry },
        );
      } else {
        await updateWorkflowRunStep(job.stepId, { status: "running" });
        try {
          await settleStepResult({
            runId: job.runId,
            stepId: job.stepId,
            node: data.node,
            def: data.workflow.definition,
            result,
            ctx: data.ctx,
            executionCtx: { ...data.ctx, ...data.inputCtx },
            meta: data.build.meta,
            registry,
            fence: { retryCount: job.attempt },
            retryCount: job.attempt,
          });
        } catch (error) {
          // Settlement records the failure before it throws. Preserve that transaction.
          const step = await getWorkflowRunStep(job.stepId);
          if (step?.status !== "failed") throw error;
        }
      }
      const run = await getWorkflowRun(job.runId);
      if (run?.status === "waiting") await updateWorkflowRun(job.runId, { status: "running" });
      await storage.executionBus!.publish("workflow.step_job.finished", {
        jobId: id,
        runId: job.runId,
      });
    });
  } finally {
    acknowledge?.();
    if (prepared && prepared !== active.get(id)?.prepared) await prepared.release();
    await release(id);
  }
}

async function rejectCandidate(job: WorkflowStepJob, error: unknown): Promise<void> {
  const storage = getStorage();
  const message = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
  await storage.transaction(async () => {
    const step = await getWorkflowRunStep(job.stepId);
    if (
      step?.status !== "waiting" ||
      step.retryCount !== job.attempt ||
      (await getRunLineageBlock(job.runId))
    )
      return;
    if (!(await storage.repos.workflowStepJobs.reject(job.id, new Date().toISOString(), message)))
      return;
    await storage.repos.workflowStepJobs.revokeStepCredentials(
      job.stepId,
      new Date().toISOString(),
    );
    await updateWorkflowRunStep(job.stepId, { status: "running" });
    await checkpointStepFailure(job.runId, job.stepId, message, job.attempt, undefined, {
      fence: { retryCount: job.attempt },
    });
    await storage.executionBus!.publish("workflow.step_job.finished", {
      jobId: job.id,
      runId: job.runId,
    });
  });
  await release(job.id);
}

export async function drainWorkflowStepJobs(): Promise<void> {
  if (draining || !registry || !getStorage().capabilities.scriptRunners) return;
  draining = true;
  try {
    const storage = getStorage();
    for (const [id, job] of active)
      if (job.owner === "embedded")
        await storage.repos.workflowStepJobs.renew(
          id,
          "embedded",
          new Date().toISOString(),
          new Date(Date.now() + LEASE_MS).toISOString(),
        );
    for (const candidate of await storage.repos.workflowStepJobs.listClaimable(
      new Date().toISOString(),
    )) {
      let data: Awaited<ReturnType<typeof load>>;
      let handler: ReturnType<typeof getStepJobKind>;
      try {
        data = await load(candidate);
        handler = getStepJobKind(candidate.kind);
        const live = [...scriptRunnerSessions.values()].filter(
          (runner) => runner.socket.readyState === 1,
        );
        if (
          process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS !== undefined &&
          Number(process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS) === 0 &&
          live.length > 0 &&
          !live.some((runner) => handler.eligible?.(runner, data.build) ?? true)
        )
          throw new Error("No connected runner supports this workflow job");
      } catch (error) {
        await rejectCandidate(candidate, error);
        continue;
      }

      let slot: ReturnType<typeof reserveHeldScriptRunner>;
      try {
        slot = reserveHeldScriptRunner({
          lane: "sync",
          eligible: (runner) => handler.eligible?.(runner, data.build) ?? true,
        });
      } catch (error) {
        await rejectCandidate(candidate, error);
        continue;
      }
      if (!slot) continue;
      const job = await storage.repos.workflowStepJobs.claim(
        slot.runner.id,
        new Date().toISOString(),
        new Date(Date.now() + LEASE_MS).toISOString(),
        candidate.id,
      );
      if (!job) {
        slot.release();
        continue;
      }
      try {
        await release(job.id);
        await storage.repos.workflowStepJobs.revokeStepCredentials(
          job.stepId,
          new Date().toISOString(),
        );
        const prepared = await handler.build({ ...data.build, job });
        const controller = new AbortController();
        active.set(job.id, {
          prepared,
          releaseSlot: slot.release,
          controller,
          owner: slot.runner.id,
        });
        if (slot.runner.kind === "remote") {
          const runner = scriptRunnerSessions.get(slot.runner.id);
          if (!runner) throw new Error("Workflow job runner disconnected before dispatch");
          send(runner, { type: "job", jobId: job.id, ...prepared.job });
        } else {
          void slot.runner
            .run(prepared.job, controller.signal)
            .then((output) => settleWorkflowStepJob(job.id, slot.runner.id, output))
            .catch((error) => console.error(scrubSecrets(String(error))))
            .finally(() => void drainWorkflowStepJobs());
        }
      } catch (error) {
        const message = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(
          0,
          4096,
        );
        await storage.transaction(async () => {
          if (
            !(await storage.repos.workflowStepJobs.settle(
              job.id,
              slot.runner.id,
              new Date().toISOString(),
              "failed",
              message,
            ))
          )
            return;
          await updateWorkflowRunStep(job.stepId, { status: "running" });
          await checkpointStepFailure(
            job.runId,
            job.stepId,
            message,
            job.attempt,
            data.node.retry,
            { fence: { retryCount: job.attempt } },
          );
          await storage.executionBus!.publish("workflow.step_job.finished", {
            jobId: job.id,
            runId: job.runId,
          });
        });
        await release(job.id);
        slot.release();
      }
    }
  } finally {
    draining = false;
  }
}

async function resume(runId: string, jobId: string) {
  const run = await getWorkflowRun(runId);
  if (!run || !["running", "waiting"].includes(run.status)) return;
  const workflow = await getRunWorkflow(run);
  if (!workflow) return;
  const { rehydrateCompletedStepOutputs } = await import("../../workflows/engine");
  const ctx = { ...run.context };
  await rehydrateCompletedStepOutputs(workflow.definition, runId, ctx, registry);
  await updateWorkflowRun(runId, { status: "running" });
  for (const node of workflow.definition.nodes)
    if (node.type === "foreach") await runForeachDrive(runId, node.id, registry);
  const job = await getStorage().repos.workflowStepJobs.get(jobId);
  const step = job ? await getWorkflowRunStep(job.stepId) : null;
  let nodeId = step?.nodeId;
  const parent = nodeId ? resolveForeachParent(workflow.definition, nodeId) : null;
  if (parent) {
    const parentStep = await getLatestStepForNode(runId, parent.id);
    if (parentStep?.status !== "completed") {
      await finalizeOrWait(runId);
      return;
    }
    nodeId = parent.id;
  } else if (step?.status !== "completed") {
    await finalizeOrWait(runId);
    return;
  }
  const nodes = nodeId
    ? getSuccessors(workflow.definition, nodeId, step?.nextPort ?? undefined)
    : [];
  if (nodes.length)
    await walkGraph(
      workflow.definition,
      runId,
      ctx,
      nodes,
      registry,
      workflow.id,
      getSecretInputKeys(workflow.input),
    );
  else await finalizeOrWait(runId);
}

export function startWorkflowStepJobs(executors: ExecutorRegistry): void {
  if (!getStorage().capabilities.scriptRunners || timer) return;
  registry = executors;
  const bus = getStorage().executionBus!;
  subscriptions.push(
    bus.subscribe(
      "workflow.step_job.requested",
      "workflow-step-dispatcher",
      async () => {
        await drainWorkflowStepJobs();
      },
      { delivery: "durable" },
    ),
  );
  subscriptions.push(
    bus.subscribe(
      "workflow.step_job.finished",
      "workflow-resume",
      async ({ runId, jobId }) => {
        await resume(runId, jobId);
      },
      { delivery: "durable" },
    ),
  );
  registerHeldStepHooks({
    async heartbeat(runner, id) {
      if (!(await getStorage().repos.workflowStepJobs.get(id))) return false;
      if (
        !(await getStorage().repos.workflowStepJobs.renew(
          id,
          runner.id,
          new Date().toISOString(),
          new Date(Date.now() + LEASE_MS).toISOString(),
        ))
      )
        send(runner, { type: "cancel", jobId: id });
      return true;
    },
    async result(runner, id, output) {
      if (!(await getStorage().repos.workflowStepJobs.get(id))) return false;
      await settleWorkflowStepJob(id, runner.id, output, () =>
        send(runner, { type: "ack", jobId: id }),
      );
      runner.jobsCompleted++;
      void drainWorkflowStepJobs();
      return true;
    },
    async reconnect(runner, id) {
      const job = await getStorage().repos.workflowStepJobs.get(id);
      if (!job) return false;
      if (
        job.status !== "running" ||
        job.ownerId !== runner.id ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt <= new Date().toISOString()
      )
        send(runner, { type: "cancel", jobId: id });
      if (
        job.status === "running" &&
        job.ownerId === runner.id &&
        job.leaseExpiresAt &&
        job.leaseExpiresAt > new Date().toISOString() &&
        !active.has(id) &&
        !adoptedSlots.has(id)
      )
        adoptedSlots.set(id, adoptHeldScriptSlot(runner.id));
      return true;
    },
  });
  timer = setInterval(
    () => void drainWorkflowStepJobs().catch((error) => console.error(scrubSecrets(String(error)))),
    15000,
  );
  timer.unref();
  bus.start();
  void drainWorkflowStepJobs();
}

export async function cancelWorkflowStepJobs(runId: string): Promise<void> {
  const storage = getStorage();
  const jobs = await storage.repos.workflowStepJobs.cancelRun(runId, new Date().toISOString());
  for (const job of jobs)
    await storage.repos.workflowStepJobs.revokeStepCredentials(
      job.stepId,
      new Date().toISOString(),
    );
  storage.afterCommit(async () => {
    for (const job of jobs) {
      const runner = job.ownerId ? scriptRunnerSessions.get(job.ownerId) : undefined;
      if (runner) send(runner, { type: "cancel", jobId: job.id });
      await release(job.id);
    }
  });
}
