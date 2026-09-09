import type { IncomingMessage, ServerResponse } from "node:http";
import bundle from "../realtime/browser.generated.txt" with { type: "text" };
import { route } from "./route-def";

route({
  method: "get",
  path: "/@swarm/realtime.js",
  pattern: ["@swarm", "realtime.js"],
  summary: "Browser SDK for realtime rooms and channels",
  tags: ["Pages"],
  auth: { apiKey: false },
  responses: {
    200: { description: "JavaScript module", unstructured: "Browser JavaScript bundle" },
  },
});

export async function handleRealtimeAsset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET" || req.url?.split("?")[0] !== "/@swarm/realtime.js") return false;
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(bundle);
  return true;
}
