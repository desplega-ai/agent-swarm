import { z } from "zod";
import { isExecutorAllowedByDeployment } from "../scripts-runtime/executors/registry";
import { ShellJobConfigSchema } from "../scripts-runtime/shell-job";
import { scrubJson, scrubSecrets } from "../utils/secret-scrubber";
import { registerStepJobKind } from "./step-job-kinds";

const resultSchema = z.object({
  status: z.enum(["success", "failed"]),
  output: z.looseObject({ exitCode: z.number(), stdout: z.string(), stderr: z.string() }),
  error: z.string().optional(),
  nextPort: z.string().optional(),
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
    const config = ShellJobConfigSchema.parse(input.config);
    if (config.cwd !== undefined)
      throw new Error("A script with cwd must run on the embedded runner");
    return {
      job: { id: input.job.id, kind: "step-shell", executor: "native", input: config },
      async finish(output) {
        const parsed = resultSchema.safeParse(output.result);
        if (!parsed.success) {
          const error = scrubSecrets(output.stderr || "Shell runner did not return a valid result");
          return { status: "failed", error, output: { exitCode: -1, stdout: "", stderr: error } };
        }
        return scrubJson(parsed.data);
      },
      async release() {},
    };
  },
});
