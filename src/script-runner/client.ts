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
import { runWithCapacityRetry } from "../scripts-runtime/dispatch/capacity-retry";
import type { ExecutorOutput, ScriptExecutorName } from "../scripts-runtime/executors/types";
import { scrubSecrets } from "../utils/secret-scrubber";
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
        executors: options.executors,
        held: [],
      }),
    );
    current.on("message", (data, binary) => {
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
        } else if (message.type === "job") {
          if (
            !welcomed ||
            jobs.has(message.jobId) ||
            jobs.size >= options.slots ||
            !options.executors.includes(message.executor)
          )
            throw new Error("invalid job");
          const controller = new AbortController();
          const input = message.input;
          input.configPayload.system.sdkBaseUrl = { value: options.apiUrl, isSecret: false };
          input.configPayload.system.mcpBaseUrl = { value: options.apiUrl, isSecret: false };
          const done = (async () => {
            let output: ExecutorOutput;
            try {
              output = await runWithCapacityRetry(
                { id: message.jobId, kind: message.kind, executor: message.executor, input },
                controller.signal,
              );
            } catch {
              output = failedJob("executor_error");
            }
            jobs.delete(message.jobId);
            if (current.readyState === WebSocket.OPEN) {
              let frame: string;
              try {
                frame = encodeRunnerFrame({ type: "result", jobId: message.jobId, output });
              } catch {
                output = failedJob("executor_error");
                frame = encodeRunnerFrame({ type: "result", jobId: message.jobId, output });
              }
              try {
                current.send(frame, (error) => {
                  if (error) current.terminate();
                });
              } catch {
                current.terminate();
              }
            }
            log(`${message.jobId} ${output.error ?? "completed"}`);
          })();
          jobs.set(message.jobId, { controller, done });
        } else if (message.type === "cancel") jobs.get(message.jobId)?.controller.abort();
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
      stopped = true;
      clearReady();
      clearTimeout(reconnect);
      socket?.terminate();
      await killJobs();
    },
  };
}
