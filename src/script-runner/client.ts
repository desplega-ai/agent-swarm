import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { WebSocket } from "ws";
import type { ScriptExecutionResult } from "../script-workflows/executor";
import { runWithCapacityRetry } from "../scripts-runtime/dispatch/capacity-retry";
import type { ExecutorOutput, ScriptExecutorName } from "../scripts-runtime/executors/types";
import { availableShellRuntimes } from "../scripts-runtime/shell-job";
import { createValueScrubber, scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import { type DurableGuest, startDurableGuest } from "./durable-job";
import {
  apiMessage,
  encodeRunnerFrame,
  failedJob,
  MAX_FRAME_BYTES,
  RUNNER_WATCHDOG_MS,
  SCRIPT_RUNNER_PATH,
} from "./protocol";

export function runnerReadyFile(path?: string) {
  if (!path) return { clear() {}, publish() {} };
  const target = resolve(path);
  const parent = dirname(target);
  const validate = () => {
    const stat = lstatSync(parent);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.geteuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      realpathSync(parent) !== parent
    )
      throw new Error("Ready file requires a private directory owned by the runner");
    try {
      const file = lstatSync(target);
      if (!file.isFile() || file.uid !== stat.uid) throw new Error("Invalid ready file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  validate();
  return {
    clear() {
      validate();
      rmSync(target, { force: true });
    },
    publish() {
      validate();
      const temporary = `${target}.${crypto.randomUUID()}`;
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error("Invalid ready temporary file");
        writeFileSync(fd, "ready\n");
        renameSync(temporary, target);
      } finally {
        closeSync(fd);
        rmSync(temporary, { force: true });
      }
    },
  };
}

export function startScriptRunner(options: {
  apiUrl: string;
  token: string;
  slots: number;
  executors: ScriptExecutorName[];
  onRefused: () => void;
  readyFile?: string;
}) {
  const ready = runnerReadyFile(options.readyFile);
  const clearReady = () => ready.clear();
  clearReady();
  const instanceId = crypto.randomUUID();
  const url = new URL(SCRIPT_RUNNER_PATH, options.apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    console.warn(scrubSecrets("[script-runner] warning: unencrypted remote connection"));
  let stopped = false;
  let attempt = 0;
  let disconnectedAt = Date.now();
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket;
  type HeldGuest = {
    cancelled?: boolean;
    guest?: DurableGuest;
    done: Promise<void>;
    result?: ScriptExecutionResult;
    confirm(): void;
    deadline?: ReturnType<typeof setTimeout>;
  };
  const durable = new Map<string, HeldGuest>();
  let sendCurrent: (message: unknown) => void = () => {};
  type HeldStep = {
    controller: AbortController;
    done: Promise<void>;
    result?: ExecutorOutput;
    confirm(): void;
    deadline?: ReturnType<typeof setTimeout>;
  };
  const steps = new Map<string, HeldStep>();
  const runtimes = availableShellRuntimes();
  const expireStep = (job: HeldStep) => {
    job.controller.abort();
    job.confirm();
  };
  let heartbeatNonce = "";
  let heartbeatSentAt = 0;
  const sendHeartbeat = () => {
    heartbeatNonce = crypto.randomUUID();
    heartbeatSentAt = performance.now();
    sendCurrent({
      type: "heartbeat",
      nonce: heartbeatNonce,
      jobs: [...durable.keys(), ...steps.keys()],
    });
  };
  const expire = (job: HeldGuest) => {
    job.cancelled = true;
    job.confirm();
    void job.guest?.stop();
  };
  const heartbeat = setInterval(sendHeartbeat, 10000);
  const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const log = (message: string) => console.log(scrubSecrets(`[script-runner] ${message}`));
  const killJobs = async () => {
    for (const job of jobs.values()) job.controller.abort();
    await Promise.all([...jobs.values()].map((job) => job.done));
  };
  const connect = () => {
    if (stopped) return;
    clearReady();
    socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${options.token}` },
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 5000,
    });
    const current = socket;
    let welcomed = false;
    const send = (message: unknown) => {
      try {
        current.send(encodeRunnerFrame(message), (error) => {
          if (error) current.terminate();
        });
      } catch {
        current.terminate();
      }
    };
    sendCurrent = send;
    let watchdog: ReturnType<typeof setTimeout>;
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        current.terminate();
        void killJobs();
      }, RUNNER_WATCHDOG_MS);
    };
    resetWatchdog();
    current.on("ping", resetWatchdog);
    const welcomeTimeout = setTimeout(() => current.terminate(), 10000);
    current.on("open", () =>
      send({
        type: "hello",
        instanceId,
        version: 1,
        slots: options.slots,
        stepJobs: true,
        executors: options.executors,
        runtimes,
        held: [...durable.keys(), ...steps.keys()],
      }),
    );
    current.on("message", (data, binary) => {
      if (current !== socket || stopped) return;
      try {
        if (binary) throw new Error("binary");
        const message = apiMessage.parse(JSON.parse(data.toString()));
        if (message.type === "welcome") {
          if (welcomed) throw new Error("duplicate welcome");
          welcomed = true;
          clearTimeout(welcomeTimeout);
          attempt = 0;
          disconnectedAt = Date.now();
          ready.publish();
          log("connected");
          for (const [id, job] of steps)
            if (job.result) send({ type: "result", jobId: id, output: job.result });
          for (const job of durable.values()) job.guest?.reconnect();
          for (const [id, job] of durable)
            if (job.result) send({ type: "durable-result", jobId: id, ...job.result });
        } else if (message.type === "durable-job") {
          if (
            !welcomed ||
            stopped ||
            durable.has(message.jobId) ||
            jobs.has(message.jobId) ||
            steps.has(message.jobId) ||
            jobs.size + durable.size + steps.size >= options.slots ||
            !options.executors.includes("native")
          ) {
            if (
              !durable.has(message.jobId) &&
              !jobs.has(message.jobId) &&
              !steps.has(message.jobId)
            )
              sendCurrent({
                type: "durable-result",
                jobId: message.jobId,
                exitCode: null,
                stderr: "Runner rejected job",
                terminated: true,
              });
            return;
          }
          let confirm!: () => void;
          const confirmed = new Promise<void>((resolve) => {
            confirm = resolve;
          });
          const job: HeldGuest = { done: Promise.resolve(), confirm };
          job.deadline = setTimeout(() => expire(job), 15000);
          durable.set(message.jobId, job);
          job.done = (async () => {
            try {
              await confirmed;
              if (job.cancelled) throw new Error("Guest lease expired before start");
              job.guest = await startDurableGuest(message.run, (frame) =>
                sendCurrent({ type: "cap", jobId: message.jobId, frame }),
              );
              if (job.cancelled) await job.guest.stop();
              job.result = await job.guest.execution.exited;
              await job.guest.execution.cleanup();
            } catch {
              job.result = {
                exitCode: 1,
                stderr: "Durable guest failed",
                ...(job.cancelled ? { terminated: true } : {}),
              };
            }
            try {
              encodeRunnerFrame({ type: "durable-result", jobId: message.jobId, ...job.result });
            } catch {
              job.result = { exitCode: 1, stderr: "Durable result exceeds byte limit" };
            }
            clearTimeout(job.deadline);
            sendCurrent({ type: "durable-result", jobId: message.jobId, ...job.result });
          })();
          sendHeartbeat();
        } else if (message.type === "lease") {
          if (message.nonce !== heartbeatNonce) return;
          for (const renewed of message.jobs) {
            const step = steps.get(renewed.jobId);
            if (step && !step.result && !step.controller.signal.aborted) {
              clearTimeout(step.deadline);
              const remaining = heartbeatSentAt + renewed.leaseMs - performance.now();
              if (remaining <= 0) expireStep(step);
              else {
                step.deadline = setTimeout(() => expireStep(step), remaining);
                step.confirm();
              }
            }
            const job = durable.get(renewed.jobId);
            if (!job || job.result || job.cancelled) continue;
            clearTimeout(job.deadline);
            const remaining = heartbeatSentAt + renewed.leaseMs - performance.now();
            if (remaining <= 0) expire(job);
            else {
              job.deadline = setTimeout(() => expire(job), remaining);
              job.confirm();
            }
          }
        } else if (message.type === "cap") {
          durable.get(message.jobId)?.guest?.receive(message.frame);
        } else if (message.type === "ack") {
          const guest = durable.get(message.jobId);
          if (guest?.result) {
            clearTimeout(guest.deadline);
            durable.delete(message.jobId);
          }
          const step = steps.get(message.jobId);
          if (step?.result) {
            clearTimeout(step.deadline);
            steps.delete(message.jobId);
          }
        } else if (message.type === "job") {
          if (
            !welcomed ||
            stopped ||
            jobs.has(message.jobId) ||
            steps.has(message.jobId) ||
            durable.has(message.jobId) ||
            (message.kind === "step-shell" && !runtimes.includes(message.input.runtime)) ||
            jobs.size + durable.size + steps.size >= options.slots ||
            !options.executors.includes(message.executor)
          ) {
            if (
              !jobs.has(message.jobId) &&
              !steps.has(message.jobId) &&
              !durable.has(message.jobId)
            )
              sendCurrent({
                type: "result",
                jobId: message.jobId,
                output: failedJob("executor_error"),
              });
            return;
          }
          const controller = new AbortController();
          const held = message.kind !== "inline";
          const completed = Promise.resolve();
          let confirm!: () => void;
          const confirmed = new Promise<void>((resolve) => {
            confirm = resolve;
          });
          const record: HeldStep = { controller, done: completed, confirm };
          if (held) record.deadline = setTimeout(() => expireStep(record), 15000);
          if (held) steps.set(message.jobId, record);
          if (message.kind !== "step-shell") {
            message.input.configPayload.system.sdkBaseUrl = {
              value: options.apiUrl,
              isSecret: false,
            };
            message.input.configPayload.system.mcpBaseUrl = {
              value: options.apiUrl,
              isSecret: false,
            };
          }
          const done = (async () => {
            let output: ExecutorOutput;
            try {
              if (held) {
                await confirmed;
                if (controller.signal.aborted)
                  throw new Error("Workflow job lease expired before start");
              }
              output = await runWithCapacityRetry(
                message.kind === "step-shell"
                  ? {
                      id: message.jobId,
                      kind: "step-shell",
                      executor: "native",
                      input: message.input,
                    }
                  : {
                      id: message.jobId,
                      kind: message.kind,
                      executor: message.executor,
                      input: message.input,
                    },
                controller.signal,
              );
            } catch {
              output = failedJob("executor_error");
            }
            if (message.kind === "step-script") {
              const scrubber = createValueScrubber(
                Object.entries(message.input.configPayload.user)
                  .filter(([, value]) => value.isSecret)
                  .map(([key, value]) => ({ name: `config:${key}`, value: value.value }))
                  .concat([
                    {
                      name: "run-credential",
                      value: message.input.configPayload.system.apiKey.value,
                    },
                  ]),
              );
              output = {
                ...output,
                result: scrubObject(scrubber.object(output.result)),
                stdout: scrubSecrets(scrubber.text(output.stdout)),
                stderr: scrubSecrets(scrubber.text(output.stderr)),
                ...(output.runtimeError
                  ? { runtimeError: scrubObject(scrubber.object(output.runtimeError)) }
                  : {}),
              };
            }
            try {
              encodeRunnerFrame({ type: "result", jobId: message.jobId, output });
            } catch {
              output = failedJob("executor_error");
            }
            if (held) {
              record.result = output;
              clearTimeout(record.deadline);
            } else jobs.delete(message.jobId);
            if (socket.readyState === WebSocket.OPEN) {
              let frame: string;
              try {
                frame = encodeRunnerFrame({ type: "result", jobId: message.jobId, output });
              } catch {
                output = failedJob("executor_error");
                frame = encodeRunnerFrame({ type: "result", jobId: message.jobId, output });
              }
              try {
                socket.send(frame, (error) => {
                  if (error) current.terminate();
                });
              } catch {
                current.terminate();
              }
            }
            log(`${message.jobId} ${output.error ?? "completed"}`);
          })();
          record.done = done;
          if (!held) jobs.set(message.jobId, { controller, done });
          else sendHeartbeat();
        } else if (message.type === "cancel") {
          jobs.get(message.jobId)?.controller.abort();
          const step = steps.get(message.jobId);
          if (step) {
            clearTimeout(step.deadline);
            expireStep(step);
            void step.done.then(() => steps.delete(message.jobId));
          }
          const job = durable.get(message.jobId);
          if (job) {
            expire(job);
            void (async () => {
              if (!job.guest) await job.done;
              await job.guest?.stop();
              await job.done;
              durable.delete(message.jobId);
            })();
          }
        }
      } catch {
        current.close(1008, "Invalid API message");
      }
    });
    current.on("error", () => {
      log("connection_error");
      current.terminate();
    });
    current.on("unexpected-response", (_req, response) => {
      response.resume();
      if (response.statusCode === 401 || response.statusCode === 409) {
        stopped = true;
        options.onRefused();
      }
      current.terminate();
    });
    current.on("close", (code) => {
      clearReady();
      clearTimeout(welcomeTimeout);
      clearTimeout(watchdog);
      if (welcomed) disconnectedAt = Date.now();
      void killJobs().then(() => {
        if (code === 1008) {
          stopped = true;
          options.onRefused();
        }
        if (stopped) return;
        const delay =
          Date.now() - disconnectedAt < 30000
            ? 1000
            : Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) * (1 + Math.random() * 0.25);
        reconnect = setTimeout(connect, delay);
      });
    });
  };
  connect();
  return {
    async stop() {
      sendCurrent({ type: "draining" });
      stopped = true;
      clearInterval(heartbeat);
      clearReady();
      clearTimeout(reconnect);
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...jobs.values()].map((job) => job.done)),
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(grace);
      await killJobs();
      for (const step of steps.values()) {
        clearTimeout(step.deadline);
        expireStep(step);
      }
      await Promise.all([...steps.values()].map((step) => step.done));
      steps.clear();
      await Promise.all(
        [...durable.values()].map(async (job) => {
          clearTimeout(job.deadline);
          expire(job);
          await job.guest?.stop();
          await job.done;
        }),
      );
      socket?.close(1000, "Runner drained");
    },
  };
}
