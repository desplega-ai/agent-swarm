import "../shell-step-job";
import { z } from "zod";
import { scriptRunnerSessions } from "../../be/script-runners/sessions";
import { isExecutorAllowedByDeployment } from "../../scripts-runtime/executors/registry";
import {
  executeShellJob,
  ShellJobConfigSchema as ScriptConfigSchema,
} from "../../scripts-runtime/shell-job";
import type { ExecutorMeta } from "../../types";
import { parkStepJob, shouldParkScriptNode } from "../step-jobs";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Schemas ────────────────────────────────────────────────
export { ShellJobConfigSchema as ScriptConfigSchema } from "../../scripts-runtime/shell-job";

export const ScriptOutputSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
});

// ─── Executor ───────────────────────────────────────────────

export const WORKFLOW_SCRIPT_NATIVE_REFUSED =
  'Workflow script nodes run as a native subprocess, which is not permitted when deployment SCRIPT_EXECUTOR="quickjs"';

export class ScriptExecutor extends BaseExecutor<
  typeof ScriptConfigSchema,
  typeof ScriptOutputSchema
> {
  readonly type = "script";
  readonly mode = "instant" as const;
  readonly configSchema = ScriptConfigSchema;
  readonly outputSchema = ScriptOutputSchema;

  protected async execute(
    config: z.infer<typeof ScriptConfigSchema>,
    _context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof ScriptOutputSchema>>> {
    if (config.cwd === "") config = { ...config, cwd: undefined };
    // Same deployment ceiling as inline and durable script runs; checked per run because the setting can change after the workflow was saved.
    if (!isExecutorAllowedByDeployment("native")) {
      return {
        status: "failed",
        error: WORKFLOW_SCRIPT_NATIVE_REFUSED,
        output: { exitCode: -1, stdout: "", stderr: WORKFLOW_SCRIPT_NATIVE_REFUSED },
      };
    }

    const embeddedDisabled =
      process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS !== undefined &&
      Number(process.env.SCRIPT_EMBEDDED_RUNNER_SLOTS) === 0;
    const matchingRunner = [...scriptRunnerSessions.values()].some(
      (runner) =>
        runner.stepJobs &&
        runner.executors.includes("native") &&
        runner.runtimes.includes(config.runtime),
    );
    if (config.cwd !== undefined && embeddedDisabled) {
      const error = "A workflow script with cwd requires the embedded runner";
      return { status: "failed", error, output: { exitCode: -1, stdout: "", stderr: error } };
    }
    if (
      !config.cwd &&
      shouldParkScriptNode() &&
      (matchingRunner || scriptRunnerSessions.size === 0)
    ) {
      return parkStepJob("step-shell", _meta, _context);
    }
    if (embeddedDisabled) {
      const error = `Script runtime '${config.runtime}' is unavailable on connected script runners`;
      return { status: "failed", error, output: { exitCode: -1, stdout: "", stderr: error } };
    }
    return executeShellJob(config);
  }
}
