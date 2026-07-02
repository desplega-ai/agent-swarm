import { formatDuration } from "date-fns";

type RunCladeOptions = {
  msg: string;
  headless?: boolean;
  additionalArgs?: string[];
};

export const runClaude = async (opts: RunCladeOptions) => {
  const Cmd = ["claude"];

  if (opts.headless) {
    Cmd.push("--verbose");
    Cmd.push("--output-format");
    Cmd.push("stream-json");
    Cmd.push("-p");
    Cmd.push(opts.msg);
  }

  if (opts.additionalArgs && opts.additionalArgs.length > 0) {
    Cmd.push(...opts.additionalArgs);
  }

  console.debug(`[debug] Running in ${opts.headless ? "headless" : "normal"} mode`);

  const proc = Bun.spawn(Cmd, {
    env: process.env,
    stdout: opts.headless ? "pipe" : "inherit",
    stdin: opts.headless ? undefined : "inherit",
    onExit(_subprocess, exitCode, _signalCode, error) {
      console.debug(`[debug] Process exited with code ${exitCode}`);

      if (error) {
        console.error("[error]", error);
      }
    },
  });

  if (opts.headless) {
    if (proc.stdout) {
      for await (const chunk of proc.stdout) {
        // Uint8Array<ArrayBuffer>
        const lines = new TextDecoder().decode(chunk).split("\n");

        for (const line of lines) {
          if (line.trim() === "") continue;

          try {
            const json = JSON.parse(line.trim());
            console.log(json);
          } catch (_e) {
            console.error("[error] Failed to parse line:", line.trim());
          }
        }
      }
    }
  }

  await proc.exited;
  const usage = proc.resourceUsage();

  if (usage) {
    const memMB = usage.maxRSS / (1024 * 1024);

    const cpuUserSec = Number(usage.cpuTime.user) / 1_000_000;
    const cpuSysSec = Number(usage.cpuTime.system) / 1_000_000;
    const cpuTotSec = Number(usage.cpuTime.total) / 1_000_000;

    console.debug(`[debug] Max RSS: ${memMB.toFixed(2)} MB`);
    console.debug("[debug] CPU Time");
    console.debug(`[debug] > User   ${formatDuration({ seconds: cpuUserSec })}`);
    console.debug(`[debug] > System ${formatDuration({ seconds: cpuSysSec })}`);
    console.debug(`[debug] > Total  ${formatDuration({ seconds: cpuTotSec })}`);
  } else {
    console.warn("[warn] Resource usage information is not available.");
  }

  const elapsedSec = Bun.nanoseconds() / 1_000_000_000;
  console.debug(`[debug] Total elapsed time: ${formatDuration({ seconds: elapsedSec })}`);
};
