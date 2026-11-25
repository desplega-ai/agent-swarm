import { z } from "zod";
import type { ExecutorInput, ExecutorOutput } from "../scripts-runtime/executors/types";
import { ShellJobConfigSchema } from "../scripts-runtime/shell-job";
import { ScriptRunSchema } from "../types";

export const SCRIPT_RUNNER_PATH = "/api/script-runners/connect";
export const RPC_CLEANUP_GRACE_MS = 5000;
export const API_PING_INTERVAL_MS = 15000;
export const RUNNER_WATCHDOG_MS = 45000;
export const MAX_FRAME_BYTES = 80 * 1024 * 1024;
const id = z.uuid();
const executor = z.enum(["native", "quickjs"]);
const value = z.object({ value: z.string(), isSecret: z.boolean() });
const config = z.looseObject({
  system: z.looseObject({ apiKey: value, agentId: value, mcpBaseUrl: value }),
  user: z.record(z.string(), value),
});
// JSON removes prototypes. Validate resource controls before any subprocess starts.
const input = z.object({
  source: z.string(),
  args: z.unknown(),
  hostValidatedArgs: z.boolean().optional(),
  configPayload: config,
  resources: z.object({
    memoryMb: z.number().int().positive(),
    cpuTimeSec: z.number().int().positive(),
    wallClockMs: z.number().int().min(1000).max(300000),
    maxProcs: z.number().int().positive(),
    maxFdCount: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxStdoutBytes: z.number().int().positive(),
  }),
  fsMode: z.enum(["none", "workspace-rw"]),
  network: z.union([
    z.literal("open"),
    z.object({ allowPrivate: z.boolean(), allowlist: z.array(z.string()).nullable() }),
  ]),
}) as z.ZodType<Omit<ExecutorInput, "signal">>;
const output = z
  .object({
    result: z.unknown().optional(),
    durable: z
      .object({ state: z.unknown(), destroyed: z.boolean(), idleTtlSec: z.number().nullable() })
      .transform((value) => ({ ...value, state: value.state }))
      .optional(),
    stdout: z.string(),
    stderr: z.string(),
    truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }),
    durationMs: z.number().nonnegative(),
    exitCode: z.number().int(),
    error: z
      .enum([
        "timeout",
        "oom",
        "killed",
        "import_violation",
        "eval_error",
        "executor_error",
        "capacity_exceeded",
      ])
      .optional(),
    runtimeError: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string(),
        userFrames: z.array(
          z.object({ file: z.string(), line: z.number(), column: z.number(), raw: z.string() }),
        ),
        userScriptLine: z.number().optional(),
        userScriptColumn: z.number().optional(),
      })
      .optional(),
  })
  .transform((value): ExecutorOutput => ({ ...value, result: value.result }));
export const runnerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("draining") }),
  z.object({
    type: z.literal("hello"),
    instanceId: id,
    version: z.literal(1),
    slots: z.number().int().min(1).max(1024),
    executors: z.array(executor).max(2),
    runtimes: z
      .array(z.enum(["bash", "ts", "python"]))
      .max(3)
      .default([]),
    held: z.array(id).max(1024),
  }),
  z.object({ type: z.literal("result"), jobId: id, output }),
  z.object({ type: z.literal("cap"), jobId: id, frame: z.string().max(64 * 1024 * 1024) }),
  z.object({
    type: z.literal("heartbeat"),
    nonce: z.string().optional(),
    jobs: z.array(id).max(1024),
  }),
  z.object({
    type: z.literal("durable-result"),
    jobId: id,
    exitCode: z.number().int().nullable(),
    stderr: z.string(),
    output: z.unknown().optional(),
    terminated: z.boolean().optional(),
  }),
]);
export const apiMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), sessionId: id }),
  z.discriminatedUnion("kind", [
    z.object({
      type: z.literal("job"),
      jobId: id,
      kind: z.enum(["inline", "step-script"]),
      executor,
      input,
    }),
    z.object({
      type: z.literal("job"),
      jobId: id,
      kind: z.literal("step-shell"),
      executor: z.literal("native"),
      input: ShellJobConfigSchema.omit({ cwd: true }),
    }),
  ]),
  z.object({
    type: z.literal("lease"),
    nonce: z.string(),
    jobs: z.array(z.object({ jobId: id, leaseMs: z.number().positive().max(60000) })).max(1024),
  }),
  z.object({ type: z.literal("durable-job"), jobId: id, run: ScriptRunSchema }),
  z.object({ type: z.literal("cap"), jobId: id, frame: z.string().max(64 * 1024 * 1024) }),
  z.object({ type: z.literal("cancel"), jobId: id }),
  z.object({ type: z.literal("ack"), jobId: id }),
]);
export const failedJob = (error: "executor_error" | "killed"): ExecutorOutput => ({
  result: undefined,
  stdout: "",
  stderr: "",
  truncated: { stdout: false, stderr: false },
  durationMs: 0,
  exitCode: 1,
  error,
});

/** Apply the byte limit before a frame reaches the shared socket. */
export function encodeRunnerFrame(message: unknown): string {
  const frame = JSON.stringify(message);
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
    throw new Error("Runner frame exceeds byte limit");
  return frame;
}
