import { expect, spyOn, test } from "bun:test";
import { apiMessage, failedJob, runnerMessage } from "../script-runner/protocol";
import { runWithCapacityRetry } from "../scripts-runtime/dispatch/capacity-retry";
import {
  dispatchScriptJob,
  setRemoteScriptRunnerPicker,
} from "../scripts-runtime/dispatch/dispatcher";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import { DEFAULT_SCRIPT_RESOURCES } from "../scripts-runtime/executors/types";

const job = () => ({
  id: crypto.randomUUID(),
  kind: "inline" as const,
  executor: "native" as const,
  input: {
    source: "export default () => 42",
    args: {},
    fsMode: "none" as const,
    network: "open" as const,
    resources: { ...DEFAULT_SCRIPT_RESOURCES },
    configPayload: {
      system: {
        apiKey: { value: "fixture", isSecret: true as const },
        agentId: { value: crypto.randomUUID(), isSecret: false as const },
        mcpBaseUrl: { value: "http://localhost", isSecret: false as const },
      },
      user: {},
    },
  },
});

test("protocol refuses malformed jobs, results and capacity declarations", () => {
  const fixture = job();
  const frame = { type: "job", jobId: fixture.id, ...fixture };
  expect(apiMessage.safeParse(frame).success).toBe(true);
  for (const resources of [
    { ...fixture.input.resources, wallClockMs: -1 },
    { ...fixture.input.resources, maxProcs: "unlimited" },
  ]) {
    expect(apiMessage.safeParse({ ...frame, input: { ...fixture.input, resources } }).success).toBe(
      false,
    );
  }
  expect(
    runnerMessage.safeParse({
      type: "hello",
      version: 1,
      instanceId: fixture.id,
      executors: ["native"],
      slots: 0,
      held: [],
    }).success,
  ).toBe(false);
  expect(
    runnerMessage.safeParse({ type: "result", jobId: fixture.id, output: { result: 42 } }).success,
  ).toBe(false);
});

test("capacity retries keep the selected executor and create fresh instances", async () => {
  const instances = new Set<NativeScriptExecutor>();
  const previous = process.env.SCRIPT_EXECUTOR;
  const spy = spyOn(NativeScriptExecutor.prototype, "run").mockImplementation(async function (
    this: NativeScriptExecutor,
  ) {
    instances.add(this);
    process.env.SCRIPT_EXECUTOR = "quickjs";
    return { ...failedJob("executor_error"), error: "capacity_exceeded" };
  });
  try {
    expect((await runWithCapacityRetry(job())).error).toBe("capacity_exceeded");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(instances.size).toBe(3);
  } finally {
    spy.mockRestore();
    if (previous === undefined) delete process.env.SCRIPT_EXECUTOR;
    else process.env.SCRIPT_EXECUTOR = previous;
  }
});

test("capacity retry stops after cancellation", async () => {
  const abort = new AbortController();
  const spy = spyOn(NativeScriptExecutor.prototype, "run").mockImplementation(async () => {
    abort.abort();
    return { ...failedJob("executor_error"), error: "capacity_exceeded" };
  });
  try {
    await runWithCapacityRetry(job(), abort.signal);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});

test("remote dispatch refuses the operator key before transport", async () => {
  const previous = process.env.AGENT_SWARM_API_KEY;
  process.env.AGENT_SWARM_API_KEY = "fixture-operator-key";
  let sent = 0;
  setRemoteScriptRunnerPicker(() => ({
    id: "fixture",
    kind: "remote",
    async run() {
      sent++;
      return failedJob("executor_error");
    },
  }));
  try {
    const fixture = job();
    fixture.input.configPayload.system.apiKey.value = "fixture-operator-key";
    await expect(dispatchScriptJob(fixture)).rejects.toThrow("operator key");
    expect(sent).toBe(0);
  } finally {
    setRemoteScriptRunnerPicker(undefined);
    if (previous === undefined) delete process.env.AGENT_SWARM_API_KEY;
    else process.env.AGENT_SWARM_API_KEY = previous;
  }
});
