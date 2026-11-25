import { z } from "zod";
import { isExecutorAllowedByDeployment } from "../../scripts-runtime/executors/registry";
import {
  executeShellJob,
  ShellJobConfigSchema as ScriptConfigSchema,
} from "../../scripts-runtime/shell-job";
import type { ExecutorMeta } from "../../types";
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
    // Same deployment ceiling as inline and durable script runs; checked per run because the setting can change after the workflow was saved.
    if (!isExecutorAllowedByDeployment("native")) {
      return {
        status: "failed",
        error: WORKFLOW_SCRIPT_NATIVE_REFUSED,
        output: { exitCode: -1, stdout: "", stderr: WORKFLOW_SCRIPT_NATIVE_REFUSED },
      };
    }

    return executeShellJob(config);
  }
}
