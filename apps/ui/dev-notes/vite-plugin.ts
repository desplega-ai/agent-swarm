import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Plugin } from "vite";
import {
  addNote,
  type DevNotePatch,
  type NewDevNote,
  readNotes,
  removeNote,
  resolveNotesFile,
  updateNote,
} from "./store";

const ROUTE = "/__dev-notes/notes";
const CHANGED_EVENT = "dev-notes:changed";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Dev notes: a review overlay for the dev server only. With `DEV_NOTES=1`,
 * `vite` injects `src/dev/dev-notes.tsx` into the page and serves a small
 * notes API at `/__dev-notes/notes`. Production builds never include either.
 * Notes live in `DEV_NOTES_FILE` (default `apps/ui/.dev-notes/notes.json`).
 * Agents read and resolve them with `bun dev-notes/cli.ts`.
 */
export function devNotes(): Plugin {
  const flag = (process.env.DEV_NOTES ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true";
  const file = resolveNotesFile();

  return {
    name: "dev-notes",
    apply: "serve",
    configureServer(server) {
      if (!enabled) return;
      server.config.logger.info(`  dev notes: ${path.relative(process.cwd(), file) || file}`);

      // The CLI edits the file directly; tell open tabs to refetch.
      server.watcher.add(file);
      const onFileEvent = (changed: string) => {
        if (path.resolve(changed) === file)
          server.ws.send({ type: "custom", event: CHANGED_EVENT });
      };
      server.watcher.on("add", onFileEvent);
      server.watcher.on("change", onFileEvent);

      server.middlewares.use(ROUTE, async (req, res) => {
        try {
          const ref = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\/+/, ""));
          if (req.method === "GET" && !ref) return send(res, 200, readNotes(file));
          // Agents read notes as instructions. Any site the developer visits can
          // send a cross-site text/plain POST without a preflight, so writes must
          // come from this page (fetch metadata) and carry JSON.
          const site = req.headers["sec-fetch-site"];
          const json = (req.headers["content-type"] ?? "").startsWith("application/json");
          if ((site && site !== "same-origin") || (req.method !== "DELETE" && !json)) {
            return send(res, 403, { error: "notes accept same-origin JSON writes only" });
          }
          if (req.method === "POST" && !ref) {
            const input = (await readBody(req)) as NewDevNote;
            if (typeof input.comment !== "string" || !input.comment.trim()) {
              return send(res, 400, { error: "comment is required" });
            }
            return send(res, 201, addNote(file, { ...input, comment: input.comment.trim() }));
          }
          if (req.method === "PATCH" && ref) {
            const { status, comment, reply } = (await readBody(req)) as DevNotePatch;
            if (status !== undefined && status !== "open" && status !== "done") {
              return send(res, 400, { error: "status must be open or done" });
            }
            const note = updateNote(file, ref, { status, comment, reply });
            return note ? send(res, 200, note) : send(res, 404, { error: "note not found" });
          }
          if (req.method === "DELETE" && ref) {
            return removeNote(file, ref)
              ? send(res, 200, { ok: true })
              : send(res, 404, { error: "note not found" });
          }
          return send(res, 405, { error: "method not allowed" });
        } catch (error) {
          return send(res, 500, { error: String(error) });
        }
      });
    },
    transformIndexHtml() {
      if (!enabled) return [];
      return [
        {
          tag: "script",
          attrs: { type: "module", src: "/src/dev/dev-notes.tsx" },
          injectTo: "body",
        },
      ];
    },
  };
}
