import { minimalEnv, repoRoot } from "./sut";

export function startScriptRunner(baseUrl: string, token: string, slots = 1) {
  let logs = "";
  const child = Bun.spawn(
    ["bun", "run", "src/cli.tsx", "script-runner", "--api-url", baseUrl, "--allow-shared-uid"],
    {
      cwd: repoRoot,
      env: {
        ...minimalEnv(),
        SCRIPT_RUNNER_TOKEN: token,
        SCRIPT_RUNNER_SLOTS: String(slots),
        DESPLEGA_TELEMETRY_ENV: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  return {
    logs: () => logs,
    signal(signal: "SIGSTOP" | "SIGCONT") {
      child.kill(signal);
    },
    async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
      child.kill(signal);
      await child.exited;
      await drained;
    },
  };
}

export async function benchmarkScripts(baseUrl: string, apiKey: string) {
  const child = Bun.spawn(
    ["bun", "scripts/bench-script-run.ts", "--url", baseUrl, "--n", "20", "--warmup", "2"],
    {
      cwd: repoRoot,
      env: { ...minimalEnv(), AGENT_SWARM_API_KEY: apiKey, DESPLEGA_TELEMETRY_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = await new Response(child.stdout).text();
  const error = await new Response(child.stderr).text();
  if ((await child.exited) !== 0)
    throw new Error(`Benchmark failed with ${error.length} diagnostic bytes`);
  return JSON.parse(output);
}
