import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  initDb,
  insertTaskAttachment,
} from "../be/db";
import { buildResumePrompt, getPausedTasksFromAPI } from "../commands/runner";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const dbPath = `/tmp/test-deployment-resume-${crypto.randomUUID()}.sqlite`;
let server: Server;
let apiUrl: string;
let agentId: string;
const outputSchema = {
  type: "object",
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

beforeAll(async () => {
  initDb(dbPath);
  agentId = (await createAgent({ name: "resume-worker", isLead: false, status: "idle" })).id;
  server = createServer(async (req, res) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "resume-test" });
    if (
      await handleTasks(
        req,
        res,
        getPathSegments(req.url ?? ""),
        parseQueryParams(req.url ?? ""),
        req.headers["x-agent-id"] as string | undefined,
      )
    )
      return;
    res.writeHead(404).end();
  });
  const port = await listenOnFreePort(server);
  apiUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await rm(dbPath + suffix, { force: true });
});

describe("deployment resume context", () => {
  for (const progress of [undefined, "Read the first page"]) {
    test(`paused task retains its attachment and output schema (${progress ? "with" : "without"} progress)`, async () => {
      const task = await createTaskExtended("Summarize the attached input", {
        agentId,
        outputSchema,
      });
      await getDbClient().run(
        "UPDATE agent_tasks SET status = 'paused', progress = ? WHERE id = ?",
        [progress ?? null, task.id],
      );
      const attachment = await insertTaskAttachment({
        taskId: task.id,
        kind: "url",
        name: "input.txt",
        url: "https://example.com/input.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
      });
      const tasks = await getPausedTasksFromAPI({ apiUrl, apiKey: "test-key", agentId });
      const paused = tasks.find((row) => row.id === task.id);
      expect(paused).toBeDefined();
      if (!paused) throw new Error("Paused task missing");
      expect(paused.outputSchema).toEqual(outputSchema);
      expect(paused.attachments).toContainEqual(
        expect.objectContaining({ id: attachment.id, name: "input.txt" }),
      );
      const prompt = await buildResumePrompt(paused);
      expect(prompt).toContain(`/work-on-task ${task.id}`);
      expect(prompt).toContain(`/api/fs/tasks/${task.id}/files/${attachment.id}/raw`);
      expect(prompt).toContain("input.txt");
      expect(prompt).toContain("**Required Output Format**");
      expect(prompt).toContain(JSON.stringify(outputSchema, null, 2));
      expect(prompt).toContain(progress ?? "No progress was saved");
    });
  }

  test("legacy tasks without a schema retain the generic completion instruction", async () => {
    const prompt = await buildResumePrompt({ id: "task", task: "Continue" });
    expect(prompt).toContain('status: "completed"');
    expect(prompt).not.toContain("Required Output Format");
  });

  test("providers without MCP omit the MCP output instruction", async () => {
    const prompt = await buildResumePrompt(
      { id: "task", task: "Continue", outputSchema },
      undefined,
      { hasMcp: false },
    );
    expect(prompt).not.toContain("store-progress");
    expect(prompt).not.toContain("/work-on-task");
  });
});
