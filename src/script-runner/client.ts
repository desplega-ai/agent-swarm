import { rmSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";
import { runWithCapacityRetry } from "../scripts-runtime/dispatch/capacity-retry";
import type { ExecutorOutput, ScriptExecutorName } from "../scripts-runtime/executors/types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { apiMessage, failedJob, MAX_FRAME_BYTES, SCRIPT_RUNNER_PATH } from "./protocol";

export function startScriptRunner(options: {
  apiUrl: string;
  token: string;
  slots: number;
  executors: ScriptExecutorName[];
  onRefused: () => void;
}) {
  const clearReady = () => rmSync("/tmp/script-runner.ready", { force: true });
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
    const welcomeTimeout = setTimeout(() => current.terminate(), 10000);
    current.on("open", () =>
      current.send(
        JSON.stringify({
          type: "hello",
          instanceId,
          version: 1,
          slots: options.slots,
          executors: options.executors,
          held: [],
        }),
      ),
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
          writeFileSync("/tmp/script-runner.ready", "ready\n", { mode: 0o600 });
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
            if (current.readyState === WebSocket.OPEN)
              current.send(JSON.stringify({ type: "result", jobId: message.jobId, output }));
            log(`${message.jobId} ${output.error ?? "completed"}`);
          })();
          jobs.set(message.jobId, { controller, done });
        } else if (message.type === "cancel") jobs.get(message.jobId)?.controller.abort();
      } catch {
        current.close(1008, "Invalid API message");
      }
    });
    current.on("error", () => log("connection_error"));
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
