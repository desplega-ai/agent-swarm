import { z } from "zod";
import { isExecutorAllowedByDeployment } from "../scripts-runtime/executors/registry";
import { mapShellJobResult, ShellJobConfigSchema } from "../scripts-runtime/shell-job";
import { scrubSecrets } from "../utils/secret-scrubber";
import { registerStepJobKind } from "./step-job-kinds";

const resultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  executionError: z.string().optional(),
});

registerStepJobKind("step-shell", {
  eligible(runner, input) {
    const config = ShellJobConfigSchema.parse(input.config);
    return (
      (runner.executors?.includes("native") ?? false) &&
      (runner.runtimes?.includes(config.runtime) ?? false)
    );
  },
  async build(input) {
    if (!isExecutorAllowedByDeployment("native"))
      throw new Error("Deployment does not permit native workflow scripts");
    const { cwd, ...config } = ShellJobConfigSchema.parse(input.config);
    if (cwd !== undefined && cwd !== "")
      throw new Error("A script with cwd must run on the embedded runner");
    return {
      job: { id: input.job.id, kind: "step-shell", executor: "native", input: config },
      async finish(output) {
        const parsed = resultSchema.safeParse(output.result);
        if (!parsed.success) {
          const error = scrubSecrets(output.stderr || "Shell runner did not return a valid result");
          return { status: "failed", error, output: { exitCode: -1, stdout: "", stderr: error } };
        }
        const raw = parsed.data;
        return mapShellJobResult({
          ...raw,
          stdout: scrubSecrets(raw.stdout),
          stderr: scrubSecrets(raw.stderr),
          ...(raw.executionError !== undefined
            ? { executionError: scrubSecrets(raw.executionError) }
            : {}),
        });
      },
      async release() {},
    };
  },
});
