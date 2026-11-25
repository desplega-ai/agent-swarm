import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  activeScriptRunnerCredential,
  scriptRunnerCredentialHash,
} from "../be/script-runners/credentials";
import {
  durableCapability,
  durableHeartbeat,
  durableResult,
  pickDurableRunner,
  reconnectDurable,
  releaseDurableOwner,
} from "../be/script-runners/durable-dispatch";
import { RemoteScriptRunner, scriptRunnerSessions } from "../be/script-runners/sessions";
import { getStorage } from "../be/storage";
import {
  API_PING_INTERVAL_MS,
  MAX_FRAME_BYTES,
  runnerMessage,
  SCRIPT_RUNNER_PATH,
} from "../script-runner/protocol";
import { drainScriptQueue, setRemoteScriptRunnerPicker } from "../scripts-runtime/dispatch/dispatcher";
import {
  heldScriptSlots,
  setHeldScriptRunnerPicker,
} from "../scripts-runtime/dispatch/held-reservations";
import { registerSessionTokenConnection } from "../utils/session-token-connections";
import { route } from "./route-def";

route({
  method: "get",
  path: SCRIPT_RUNNER_PATH,
  pattern: ["api", "script-runners", "connect"],
  tags: ["Script runners"],
  summary: "Connect a script runner with its dedicated bearer credential",
  responses: {
    101: { description: "WebSocket upgrade" },
    401: { description: "Invalid runner credential" },
    409: { description: "script_runners_need_postgres" },
    503: { description: "Runner credential lookup temporarily unavailable" },
  },
});

export function attachScriptRunnerTransport(server: Server): () => void {
  setHeldScriptRunnerPicker(pickDurableRunner);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let closing = false;
  setRemoteScriptRunnerPicker((job) =>
    [...scriptRunnerSessions.values()].find(
      (runner) =>
        runner.socket.readyState === WebSocket.OPEN &&
        runner.pending.size + heldScriptSlots(runner.id) < runner.slots &&
        runner.executors.includes(job.executor),
    ),
    () => [...scriptRunnerSessions.values()].reduce((sum, runner) => sum + runner.slots, 0),
  );
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url?.split("?")[0] !== SCRIPT_RUNNER_PATH) return;
    const reject = (code: number, reason: string) =>
      socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n${reason}`);
    if (!getStorage().capabilities.scriptRunners) {
      reject(409, "script_runners_need_postgres");
      return;
    }
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const hash = bearer && scriptRunnerCredentialHash(bearer);
    if (!hash) {
      reject(401, "Unauthorized");
      return;
    }
    void activeScriptRunnerCredential(hash)
      .then((credential) => {
        if (closing || socket.destroyed) return socket.destroy();
        if (!credential) {
          reject(401, "Unauthorized");
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const unregister = registerSessionTokenConnection(`script-runner:${credential.id}`, () =>
            ws.close(1008, "Credential revoked"),
          );
          let helloTimeout = setTimeout(() => ws.close(1011, "Runner admission timed out"), 5000);
          const admission = activeScriptRunnerCredential(hash)
            .then((current) => {
              clearTimeout(helloTimeout);
              if (!current) ws.close(1008, "Credential expired or revoked");
              else if (ws.readyState === WebSocket.OPEN)
                helloTimeout = setTimeout(() => ws.close(1008, "Hello required"), 5000);
              return !!current;
            })
            .catch(() => {
              ws.close(1011, "Credential lookup unavailable");
              return false;
            });
          let runner: RemoteScriptRunner | undefined;
          let alive = true;
          let checking = false;
          const ping = setInterval(() => {
            if (checking) return;
            checking = true;
            void activeScriptRunnerCredential(hash)
              .then((current) => {
                if (!current) ws.close(1008, "Credential expired or revoked");
                else if (!alive) ws.terminate();
                else {
                  alive = false;
                  ws.ping(undefined, undefined, (error) => {
                    if (error) ws.terminate();
                  });
                }
              })
              .catch(() => ws.close(1011, "Credential lookup unavailable"))
              .finally(() => {
                checking = false;
              });
          }, API_PING_INTERVAL_MS);
          ws.on("pong", () => {
            alive = true;
          });
          ws.on("error", () => ws.terminate());
          ws.on("message", (data, binary) => {
            void admission.then(async (authorized) => {
              if (!authorized || ws.readyState !== WebSocket.OPEN) return;
              try {
                if (binary) throw new Error("binary");
                const message = runnerMessage.parse(JSON.parse(data.toString()));
                if (message.type === "hello") {
                  if (runner) throw new Error("hello");
                  if (scriptRunnerSessions.has(message.instanceId)) {
                    ws.close(1011, "Runner instance is still connected");
                    return;
                  }
                  clearTimeout(helloTimeout);
                  runner = new RemoteScriptRunner(
                    message.instanceId,
                    message.slots,
                    message.executors,
                    ws,
                  );
                  scriptRunnerSessions.set(runner.id, runner);
                  ws.send(
                    JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }),
                    (error) => {
                      if (error) ws.terminate();
                    },
                  );
                  await reconnectDurable(runner, message.held);
                  drainScriptQueue();
                } else {
                  if (!runner) throw new Error("hello required");
                  if (message.type === "heartbeat") await durableHeartbeat(runner, message.jobs);
                  else if (message.type === "cap")
                    await durableCapability(runner, message.jobId, message.frame);
                  else if (message.type === "durable-result")
                    await durableResult(runner, message.jobId, message);
                  else runner.result(message.jobId, message.output);
                }
              } catch {
                ws.close(1008, "Invalid runner message");
              }
            });
          });
          ws.on("close", (code) => {
            unregister();
            clearTimeout(helloTimeout);
            clearInterval(ping);
            if (runner) {
              if (code === 1000 || code === 1008) void releaseDurableOwner(runner.id);
              runner.close();
              if (scriptRunnerSessions.get(runner.id) === runner)
                scriptRunnerSessions.delete(runner.id);
            }
          });
        });
      })
      .catch(() => reject(503, "Service Unavailable"));
  };
  server.on("upgrade", upgrade);
  return () => {
    closing = true;
    setHeldScriptRunnerPicker(undefined);
    server.off("upgrade", upgrade);
    setRemoteScriptRunnerPicker(undefined);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
