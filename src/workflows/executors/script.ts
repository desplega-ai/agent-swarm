import { z } from "zod";
import { isExecutorAllowedByDeployment } from "../../scripts-runtime/executors/registry";
import { MAX_SCRIPT_WALL_CLOCK_MS } from "../../scripts-runtime/executors/types";
import { executeShellJob } from "../../scripts-runtime/shell-job";
import type { ExecutorMeta } from "../../types";
import { BaseExecutor, type ExecutorResult } from "./base";

// ─── Schemas ────────────────────────────────────────────────
const RESERVED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "PWD",
  "SHLVL",
  "OLDPWD",
  // These affect native loading or libc initialization before the wrapper's ulimit.
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "LOCPATH",
  "NLSPATH",
  "GETCONF_DIR",
  // Shell startup controls and variables Bash rewrites or owns.
  "BASH",
  "BASHOPTS",
  "BASHPID",
  "ENV",
  "SHELLOPTS",
  "IFS",
  "OPTIND",
  "OPTERR",
  "PS0",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "PPID",
  "UID",
  "EUID",
  "LINENO",
  "RANDOM",
  "SRANDOM",
  "SECONDS",
  "EPOCHSECONDS",
  "EPOCHREALTIME",
  "HISTCMD",
  "COMP_WORDBREAKS",
  "_",
]);
const RESERVED_ENV_PREFIXES = ["LD_", "DYLD_", "BASH_"];

export const ScriptConfigSchema = z.object({
  runtime: z.enum(["bash", "ts", "python"]),
  script: z.string(),
  args: z.array(z.string()).optional(),
  env: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid environment variable name")
        .refine(
          (key) => {
            const name = key.toUpperCase();
            return (
              !RESERVED_ENV_KEYS.has(name) &&
              !RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
            );
          },
          {
            message: "Cannot override a reserved script environment variable",
          },
        ),
      z.string().refine((value) => !value.includes("\0"), {
        message: "Environment variable values cannot contain NUL bytes",
      }),
    )
    .optional(),
  timeout: z.number().int().min(1000).max(MAX_SCRIPT_WALL_CLOCK_MS).default(30_000),
  cwd: z.string().optional(),
});

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
