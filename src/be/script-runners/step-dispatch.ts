import type { WorkflowStepJob } from "@desplega/storage";
import { encodeRunnerFrame } from "../../script-runner/protocol";
import {
  adoptHeldScriptSlot,
  reserveHeldScriptRunner,
} from "../../scripts-runtime/dispatch/held-reservations";
import type { ExecutorOutput } from "../../scripts-runtime/executors/types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getSuccessors } from "../../workflows/definition";
import { interpolateNodeConfig, walkGraph } from "../../workflows/engine";
import type { ExecutorResult } from "../../workflows/executors/base";
import type { ExecutorRegistry } from "../../workflows/executors/registry";
import { resolveStepNode } from "../../workflows/foreach-body";
import { runForeachDrive } from "../../workflows/foreach-driver";
import { resolveForeachParent, settleForeachChild } from "../../workflows/foreach-join";
import { getSecretInputKeys } from "../../workflows/input";
import { finalizeOrWait } from "../../workflows/resume";
import { rebuildNodeExecutionInput } from "../../workflows/step-input";
import {
  getStepJobKind,
  type PreparedStepJob,
  type StepJobBuildInput,
} from "../../workflows/step-job-kinds";
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
const embeddedOwner = crypto.randomUUID();
const runnerOwner = (runner: RemoteScriptRunner) => runner.ownerId;
const claimId = (owner: string) => owner.slice(owner.lastIndexOf(":") + 1);
const wireId = (job: WorkflowStepJob) => `${job.id}:${claimId(job.ownerId!)}`;
const rowId = (id: string) => (id.includes(":") ? id.split(":")[0]! : null);
const report = (error: unknown) => console.error(scrubSecrets(String(error)));
const active = new Map<
  string,
  {
    prepared: PreparedStepJob;
    releaseSlot: () => void;
    controller: AbortController;
    owner: string;
    deadline?: ReturnType<typeof setTimeout>;
  }
>();
const adoptedSlots = new Map<string, { owner: string; release: () => void }>();
let draining = false;
let drainAgain = false;
let registry: ExecutorRegistry;
let timer: ReturnType<typeof setInterval> | undefined;
const subscriptions: (() => void)[] = [];
const send = (runner: RemoteScriptRunner, message: unknown) =>
  runner.socket.send(encodeRunnerFrame(message));

async function load(job: WorkflowStepJob, rebuild = true) {
  const run = await getWorkflowRun(job.runId);
  const step = await getWorkflowRunStep(job.stepId);
  if (!run || !step) throw new Error("Workflow job has no run or step");
  const workflow = await getRunWorkflow(run);
  if (!workflow) throw new Error("Workflow job has no pinned definition");
  const node = resolveStepNode(workflow.definition, step.nodeId);
  if (!node) throw new Error("Workflow job has no node");
  const parent = resolveForeachParent(workflow.definition, step.nodeId);
  const execution = rebuild
    ? await rebuildNodeExecutionInput(workflow.definition, run, parent ?? node, registry)
    : { inputCtx: {}, config: node.config ?? {}, ctx: { ...run.context } };
  let inputCtx = execution.inputCtx;
  let config = execution.config;
  if (parent && rebuild) {
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
    } as StepJobBuildInput,
  };
}

async function release(id: string, owner?: string) {
  const adopted = adoptedSlots.get(id);
  if (adopted && (!owner || adopted.owner === owner)) {
    adopted.release();
    adoptedSlots.delete(id);
  }
  const held = active.get(id);
  if (!held || (owner && held.owner !== owner)) return;
  active.delete(id);
  if (held) {
    try {
      clearTimeout(held.deadline);
      held.controller.abort();
      await held.prepared.release();
    } finally {
      held.releaseSlot();
    }
  }
}

async function settleOutcome(
  job: WorkflowStepJob,
  data: Awaited<ReturnType<typeof load>>,
  result: ExecutorResult,
) {
  const current = await getWorkflowRunStep(job.stepId);
  if (current?.status !== "waiting" || current.retryCount !== job.attempt) return;
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
      markRunFailed: !data.parent,
    });
  } catch (error) {
    if ((await getWorkflowRunStep(job.stepId))?.status !== "failed") throw error;
  }
  if (data.parent) {
    const settled = await getWorkflowRunStep(job.stepId);
    if (!settled || settled.nextRetryAt || !["completed", "failed"].includes(settled.status))
      return;
    await settleForeachChild(
      data.workflow.definition,
      job.runId,
      job.stepId,
      {
        status: settled.status === "failed" ? "failed" : "completed",
        output: settled.output,
        error: settled.error ?? undefined,
        nextPort: settled.nextPort ?? undefined,
      },
      data.ctx,
      { registry, from: ["completed", "failed"] },
    );
  }
  const run = await getWorkflowRun(job.runId);
  if (run?.status === "waiting") await updateWorkflowRun(job.runId, { status: "running" });
}

/** Ownership includes the authenticated runner identity and this exact claim generation. */
export async function settleWorkflowStepJob(
  id: string,
  owner: string,
  raw: ExecutorOutput,
  acknowledge?: () => void,
): Promise<boolean> {
  const storage = getStorage();
  const job = await storage.repos.workflowStepJobs.get(id);
  if (!job) {
    acknowledge?.();
    return false;
  }
  if (
    job.status !== "running" ||
    job.ownerId !== owner ||
    !job.leaseExpiresAt ||
    job.leaseExpiresAt <= new Date().toISOString()
  ) {
    acknowledge?.();
    await release(id, owner);
    return false;
  }
  let prepared: Pick<PreparedStepJob, "finish" | "release"> | undefined =
    active.get(id)?.owner === owner ? active.get(id)?.prepared : undefined;
  let temporary = false;
  let accepted = false;
  try {
    const data = await load(job, false);
    let result: ExecutorResult;
    try {
      if (!prepared) {
        const handler = getStepJobKind(job.kind);
        prepared = handler.restore
          ? await handler.restore(data.build)
          : await handler.build((await load(job)).build);
        temporary = true;
      }
      result = await prepared.finish(raw);
    } catch (error) {
      result = {
        status: "failed",
        error: scrubSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
    await storage.transaction(async () => {
      accepted = false;
      if (await getRunLineageBlock(job.runId)) return;
      accepted = await storage.repos.workflowStepJobs.settle(
        id,
        owner,
        new Date().toISOString(),
        result.status === "failed" ? "failed" : "completed",
        result.error ? scrubSecrets(result.error).slice(0, 4096) : null,
      );
      if (!accepted) return;
      await storage.repos.workflowStepJobs.revokeStepCredentials(
        job.stepId,
        new Date().toISOString(),
      );
      await settleOutcome(job, data, result);
      await storage.executionBus!.publish("workflow.step_job.finished", {
        jobId: id,
        runId: job.runId,
      });
    });
    acknowledge?.();
    await release(id, owner);
    return accepted;
  } finally {
    if (temporary) await prepared?.release();
  }
}

async function rejectCandidate(
  job: WorkflowStepJob,
  error: unknown,
  owner?: string,
): Promise<void> {
  const storage = getStorage();
  const message = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
  const data = await load(job, false);
  await storage.transaction(async () => {
    if (await getRunLineageBlock(job.runId)) return;
    const changed = owner
      ? await storage.repos.workflowStepJobs.settle(
          job.id,
          owner,
          new Date().toISOString(),
          "failed",
          message,
        )
      : await storage.repos.workflowStepJobs.reject(job.id, new Date().toISOString(), message);
    if (!changed) return;
    await storage.repos.workflowStepJobs.revokeStepCredentials(
      job.stepId,
      new Date().toISOString(),
    );
    await settleOutcome(job, data, { status: "failed", error: message });
    await storage.executionBus!.publish("workflow.step_job.finished", {
      jobId: job.id,
      runId: job.runId,
    });
  });
  await release(job.id, owner ?? job.ownerId ?? undefined);
}

export async function drainWorkflowStepJobs(): Promise<void> {
  if (!registry || !getStorage().capabilities.scriptRunners) return;
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    const storage = getStorage();
    for (const [id, job] of active) {
      if (job.owner.startsWith("embedded:")) {
        try {
          if (
            !(await storage.repos.workflowStepJobs.renew(
              id,
              job.owner,
              new Date().toISOString(),
              new Date(Date.now() + LEASE_MS).toISOString(),
            ))
          )
            await release(id, job.owner);
          else {
            clearTimeout(job.deadline);
            job.deadline = setTimeout(() => job.controller.abort(), LEASE_MS);
          }
        } catch (error) {
          await release(id, job.owner);
          report(error);
        }
      }
    }
    for (const candidate of await storage.repos.workflowStepJobs.listClaimable(
      new Date().toISOString(),
    )) {
      let data: Awaited<ReturnType<typeof load>>;
      let handler: ReturnType<typeof getStepJobKind>;
      try {
        data = await load(candidate);
        handler = getStepJobKind(candidate.kind);
        data.build = handler.prepare ? await handler.prepare(data.build) : data.build;
        const live = [...scriptRunnerSessions.values()].filter(
          (runner) => runner.socket.readyState === 1,
        );
        if (
          process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS !== undefined &&
          Number(process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS) === 0 &&
          live.length > 0 &&
          !live.some(
            (runner) =>
              runner.stepJobs === true && (handler.eligible?.(runner, data.build) ?? true),
          )
        )
          throw new Error("No connected runner supports this workflow job");
      } catch (error) {
        await rejectCandidate(candidate, error).catch(report);
        continue;
      }

      let slot: ReturnType<typeof reserveHeldScriptRunner>;
      try {
        slot = reserveHeldScriptRunner({
          lane: "sync",
          eligible: (runner) =>
            (runner.kind === "embedded" || runner.stepJobs === true) &&
            (handler.eligible?.(runner, data.build) ?? true),
        });
      } catch (error) {
        await rejectCandidate(candidate, error).catch(report);
        continue;
      }
      if (!slot) continue;
      const generation = crypto.randomUUID();
      const deliveryId = `${candidate.id}:${generation}`;
      const owner =
        (slot.runner.kind === "remote"
          ? runnerOwner(slot.runner as RemoteScriptRunner)
          : `embedded:${embeddedOwner}`) +
        ":" +
        generation;
      const job = await storage.repos.workflowStepJobs.claim(
        owner,
        new Date().toISOString(),
        new Date(Date.now() + LEASE_MS).toISOString(),
        candidate.id,
      );
      if (!job) {
        slot.release();
        continue;
      }
      try {
        await release(job.id, candidate.ownerId ?? undefined);
        await storage.repos.workflowStepJobs.revokeStepCredentials(
          job.stepId,
          new Date().toISOString(),
        );
        const prepared = await handler.build({ ...data.build, job });
        prepared.job.id = deliveryId;
        const controller = new AbortController();
        active.set(job.id, {
          prepared,
          releaseSlot: slot.release,
          controller,
          owner,
          ...(slot.runner.kind === "embedded"
            ? { deadline: setTimeout(() => controller.abort(), LEASE_MS) }
            : {}),
        });
        if (slot.runner.kind === "remote") {
          const runner = scriptRunnerSessions.get(slot.runner.id);
          if (!runner) throw new Error("Workflow job runner disconnected before dispatch");
          send(runner, { type: "job", jobId: deliveryId, ...prepared.job });
        } else {
          void slot.runner
            .run(prepared.job, controller.signal)
            .then((output) => settleWorkflowStepJob(job.id, owner, output))
            .catch((error) => console.error(scrubSecrets(String(error))))
            .finally(() => void drainWorkflowStepJobs());
        }
      } catch (error) {
        await rejectCandidate(job, error, owner).catch(report);
        await release(job.id, owner);
        slot.release();
      }
    }
  } finally {
    draining = false;
    if (drainAgain) {
      drainAgain = false;
      void drainWorkflowStepJobs().catch(report);
    }
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
      const key = rowId(id);
      if (!key) return false;
      try {
        const job = await getStorage().repos.workflowStepJobs.get(key);
        const owner = `${runnerOwner(runner)}:${id.split(":")[1]}`;
        if (
          job &&
          (await getStorage().repos.workflowStepJobs.renew(
            key,
            owner,
            new Date().toISOString(),
            new Date(Date.now() + LEASE_MS).toISOString(),
          ))
        )
          return true;
        send(runner, { type: "cancel", jobId: id });
        await release(key, owner);
      } catch (error) {
        report(error);
      }
      return false;
    },
    async result(runner, id, output) {
      const key = rowId(id);
      if (!key) return false;
      try {
        if (
          await settleWorkflowStepJob(
            key,
            `${runnerOwner(runner)}:${id.split(":")[1]}`,
            output,
            () => send(runner, { type: "ack", jobId: id }),
          )
        )
          runner.jobsCompleted++;
        void drainWorkflowStepJobs().catch(report);
      } catch (error) {
        report(error);
      }
      return true;
    },
    async reconnect(runner, id) {
      const key = rowId(id);
      if (!key) return false;
      const owner = `${runnerOwner(runner)}:${id.split(":")[1]}`;
      if (!active.has(key) && !adoptedSlots.has(key))
        adoptedSlots.set(key, { owner, release: adoptHeldScriptSlot(runner.id) });
      try {
        const job = await getStorage().repos.workflowStepJobs.get(key);
        if (
          !job ||
          job.status !== "running" ||
          job.ownerId !== owner ||
          !job.leaseExpiresAt ||
          job.leaseExpiresAt <= new Date().toISOString()
        ) {
          send(runner, { type: "cancel", jobId: id });
          await release(key, owner);
        } else if (!active.has(key) && !adoptedSlots.has(key))
          adoptedSlots.set(key, { owner, release: adoptHeldScriptSlot(runner.id) });
      } catch (error) {
        report(error);
      }
      return true;
    },
  });
  timer = setInterval(
    () => void drainWorkflowStepJobs().catch((error) => console.error(scrubSecrets(String(error)))),
    15000,
  );
  timer.unref();
  bus.start();
  void drainWorkflowStepJobs().catch(report);
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
      try {
        const runner = job.ownerId
          ? [...scriptRunnerSessions.values()].find((runner) =>
              job.ownerId!.startsWith(runnerOwner(runner) + ":"),
            )
          : undefined;
        if (runner) send(runner, { type: "cancel", jobId: wireId(job) });
        await release(job.id, job.ownerId ?? undefined);
        const handler = getStepJobKind(job.kind);
        if (handler.restore) {
          const restored = await handler.restore((await load(job, false)).build);
          await restored.release();
        }
      } catch (error) {
        report(error);
      }
    }
  });
}
