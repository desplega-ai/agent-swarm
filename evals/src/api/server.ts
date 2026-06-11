import { join } from "node:path";
import { getDb, initDb } from "../db/client.ts";
import {
  getArtifact,
  getAttempt,
  getRun,
  listArtifacts,
  listAttempts,
  listJudgments,
  listRuns,
} from "../db/queries.ts";
import { summarizeRun } from "../results.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

const UI_DIR = join(import.meta.dir, "../../ui");

export async function startServer(port = Number(process.env.EVALS_PORT ?? 4801)) {
  await initDb();
  const db = getDb();

  const server = Bun.serve({
    port,
    idleTimeout: 60,
    routes: {
      "/": () => new Response(Bun.file(join(UI_DIR, "index.html"))),
      "/api/runs": async () => {
        const runs = await listRuns(db);
        const withSummaries = await Promise.all(
          runs.map(async (run) => summarizeRun(run, await listAttempts(db, run.id))),
        );
        return json(withSummaries);
      },
      "/api/runs/:id": async (req) => {
        const run = await getRun(db, req.params.id);
        if (!run) return json({ error: "run not found" }, 404);
        const attempts = await listAttempts(db, run.id);
        return json({ ...summarizeRun(run, attempts), attempts });
      },
      "/api/attempts/:id": async (req) => {
        const attempt = await getAttempt(db, req.params.id);
        if (!attempt) return json({ error: "attempt not found" }, 404);
        const [judgments, artifacts] = await Promise.all([
          listJudgments(db, attempt.id),
          listArtifacts(db, attempt.id),
        ]);
        return json({ attempt, judgments, artifacts });
      },
      "/api/artifacts/:id": async (req) => {
        const artifact = await getArtifact(db, req.params.id);
        if (!artifact) return json({ error: "artifact not found" }, 404);
        return new Response(artifact.content, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    },
    fetch() {
      return json({ error: "not found" }, 404);
    },
  });

  console.log(`evals UI on http://localhost:${server.port}`);
  return server;
}

if (import.meta.main) {
  await startServer();
}
