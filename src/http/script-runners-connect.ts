import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  activeScriptRunnerCredential,
  scriptRunnerCredentialHash,
} from "../be/script-runners/credentials";
import { RemoteScriptRunner, scriptRunnerSessions } from "../be/script-runners/sessions";
import { getStorage } from "../be/storage";
import { MAX_FRAME_BYTES, runnerMessage, SCRIPT_RUNNER_PATH } from "../script-runner/protocol";
import { setRemoteScriptRunnerPicker } from "../scripts-runtime/dispatch/dispatcher";
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
  },
});

export function attachScriptRunnerTransport(server: Server): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  let closing = false;
  setRemoteScriptRunnerPicker((job) =>
    [...scriptRunnerSessions.values()].find(
      (runner) =>
        runner.socket.readyState === WebSocket.OPEN &&
        runner.pending.size < runner.slots &&
        runner.executors.includes(job.executor),
    ),
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
          let runner: RemoteScriptRunner | undefined;
          let alive = true;
          let checking = false;
          const helloTimeout = setTimeout(() => ws.close(1008, "Hello required"), 5000);
          const ping = setInterval(() => {
            if (checking) return;
            checking = true;
            void activeScriptRunnerCredential(hash)
              .then((current) => {
                if (!current) ws.close(1008, "Credential expired or revoked");
                else if (!alive) ws.terminate();
                else {
                  alive = false;
                  ws.ping();
                }
              })
              .catch(() => ws.close(1008, "Credential check failed"))
              .finally(() => {
                checking = false;
              });
          }, 15000);
          ws.on("pong", () => {
            alive = true;
          });
          ws.on("error", () => ws.terminate());
          ws.on("message", (data, binary) => {
            try {
              if (binary) throw new Error("binary");
              const message = runnerMessage.parse(JSON.parse(data.toString()));
              if (message.type === "hello") {
                if (runner || scriptRunnerSessions.has(message.instanceId) || message.held.length)
                  throw new Error("hello");
                clearTimeout(helloTimeout);
                runner = new RemoteScriptRunner(
                  message.instanceId,
                  message.slots,
                  message.executors,
                  ws,
                );
                scriptRunnerSessions.set(runner.id, runner);
                ws.send(JSON.stringify({ type: "welcome", sessionId: crypto.randomUUID() }));
              } else {
                if (!runner) throw new Error("hello required");
                runner.result(message.jobId, message.output);
              }
            } catch {
              ws.close(1008, "Invalid runner message");
            }
          });
          ws.on("close", () => {
            unregister();
            clearTimeout(helloTimeout);
            clearInterval(ping);
            if (runner) {
              runner.close();
              scriptRunnerSessions.delete(runner.id);
            }
          });
        });
      })
      .catch(() => reject(401, "Unauthorized"));
  };
  server.on("upgrade", upgrade);
  return () => {
    closing = true;
    server.off("upgrade", upgrade);
    setRemoteScriptRunnerPicker(undefined);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
