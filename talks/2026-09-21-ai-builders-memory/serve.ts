// Serves the deck and persists review comments (comments.json) and rehearsal runs (timings.json).
// Usage: bun talks/2026-09-21-ai-builders-memory/serve.ts   then open /?debug=1
import { join, normalize } from "node:path";

const root = import.meta.dir;

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4747),
  async fetch(req) {
    const { pathname } = new URL(req.url);

    // JSON stores written by the local tools: review comments (debug.js) and rehearsal runs (timer.js).
    if (pathname === "/comments.json" || pathname === "/timings.json") {
      const storePath = join(root, pathname.slice(1));
      if (req.method === "PUT") {
        const body = await req.json();
        if (!Array.isArray(body)) return new Response("expected an array", { status: 400 });
        await Bun.write(storePath, `${JSON.stringify(body, null, 2)}\n`);
        return Response.json({ ok: true, count: body.length });
      }
      const file = Bun.file(storePath);
      return (await file.exists()) ? new Response(file) : Response.json([]);
    }

    const target = normalize(join(root, pathname === "/" ? "index.html" : decodeURIComponent(pathname)));
    if (!target.startsWith(root)) return new Response("forbidden", { status: 403 });
    const file = Bun.file(target);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
});

console.log(`deck:   http://localhost:${server.port}/`);
console.log(`review: http://localhost:${server.port}/?debug=1`);
