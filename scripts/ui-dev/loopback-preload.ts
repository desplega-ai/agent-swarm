/**
 * Preloaded into the `--api local` child (scripts/ui-dev/local.ts): a node:http server that
 * listens on a port with no host binds 127.0.0.1, not every interface. src/http/index.ts calls
 * `httpServer.listen(port)`, and the local API holds the operator's in-progress app or page.
 * shortcut: patches the prototype in the child only; replace with a server bind-host option if a
 * deployed API ever needs one.
 */
import { Server } from "node:http";

const listen = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  if (typeof args[0] === "number" && typeof args[1] !== "string") args.splice(1, 0, "127.0.0.1");
  return listen.apply(this, args as Parameters<typeof listen>);
} as typeof listen;
