/**
 * Audio a user sends from the sessions UI or Slack gets its transcript in the
 * task text, through the same `transcribeAudio` helper as the Chat SDK path.
 * No provider configured, or a failed call: one line says so and the task is
 * still created.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getTaskAttachments,
  getTaskById,
  initDb,
} from "../be/db";
import { resetFileStorageProviderForTests } from "../fs/registry";
import { handleCore } from "../http/core";
import { handleFs } from "../http/fs";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { SlackFile } from "../slack/files";
import {
  buildEffectiveText,
  createSlackTaskWithFiles,
  fetchSlackFiles,
} from "../slack/inbound-files";
import { NOT_TRANSCRIBED_NOTE, TRANSCRIPTION_ENV_KEYS } from "../utils/transcription";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-task-audio-transcription.sqlite";
const API_KEY = "example-task-audio-key";
const BOT_TOKEN = "example-task-audio-slack-token";
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5]);
const NO_PROVIDER = NOT_TRANSCRIBED_NOTE;
const savedEnv = new Map(TRANSCRIPTION_ENV_KEYS.map((key) => [key, process.env[key]]));

let api: Server;
let apiPort: number;
let slackHost: ReturnType<typeof Bun.serve>;
let stt: ReturnType<typeof Bun.serve>;
let sttMode: "ok" | "fail" = "ok";
let sttFilenames: string[] = [];
let fsDir: string;
let agentId: string;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
}

function useTranscription(): void {
  process.env.TRANSCRIPTION_API_KEY = "stt-task-audio-key";
  process.env.TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${stt.port}/v1`;
}

beforeAll(async () => {
  await removeDbFiles();
  fsDir = await mkdtemp(join(tmpdir(), "task-audio-"));
  process.env.AGENT_FS_LOCAL_DIR = fsDir;
  delete process.env.AGENT_FS_API_URL;
  resetFileStorageProviderForTests();
  initDb(TEST_DB_PATH);

  stt = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const file = (await req.formData()).get("file") as File;
      sttFilenames.push(file.name);
      if (sttMode === "fail") {
        return Response.json({ error: { message: "upstream overloaded" } }, { status: 503 });
      }
      return Response.json({ text: " Ship the release notes today. " });
    },
  });
  slackHost = Bun.serve({
    port: 0,
    fetch: (req) =>
      req.headers.get("authorization") === `Bearer ${BOT_TOKEN}`
        ? new Response(AUDIO, { headers: { "content-type": "audio/webm" } })
        : new Response("forbidden", { status: 403 }),
  });
  api = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    const ok = await handleFs(
      req,
      res,
      getPathSegments(req.url || ""),
      parseQueryParams(req.url || ""),
      myAgentId,
    );
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  apiPort = await listenOnFreePort(api);
  agentId = (await createAgent({ name: "task-audio-lead", isLead: true, status: "idle" })).id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  stt.stop(true);
  slackHost.stop(true);
  closeDb();
  await removeDbFiles();
  await rm(fsDir, { recursive: true, force: true });
  delete process.env.AGENT_FS_LOCAL_DIR;
  resetFileStorageProviderForTests();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  sttMode = "ok";
  sttFilenames = [];
  // A provider key in the shell (OPENAI_API_KEY, ...) would switch transcription on.
  for (const key of TRANSCRIPTION_ENV_KEYS) delete process.env[key];
});

/** The composer's upload: raw body, `name` query, the file's own content type. */
function upload(taskId: string, name: string, contentType: string): Promise<Response> {
  return fetch(
    `http://localhost:${apiPort}/api/fs/tasks/${taskId}/files?name=${encodeURIComponent(name)}&intent=user-upload`,
    {
      method: "POST",
      body: AUDIO,
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": contentType },
    },
  );
}

async function draftTask(text: string): Promise<string> {
  return (await createTaskExtended(text, { agentId, source: "ui", status: "draft" })).id;
}

describe("sessions UI upload", () => {
  test("a recorded webm clip uploaded to a draft puts its transcript in the task text", async () => {
    useTranscription();
    const taskId = await draftTask("what did I say?");

    // What the composer's mic button uploads in Chrome and Firefox.
    const name = "recording-2026-10-21-143005.webm";
    const res = await upload(taskId, name, "audio/webm;codecs=opus");

    expect(res.status).toBe(201);
    expect(sttFilenames).toEqual([name]);
    expect((await getTaskById(taskId))!.task).toBe(
      `what did I say?\n\n[File: ${name} (audio/webm)]\n[Transcript of ${name}]\nShip the release notes today.`,
    );
    expect(await getTaskAttachments(taskId)).toHaveLength(1);
  });

  test("parallel audio uploads each keep their block", async () => {
    useTranscription();
    const taskId = await draftTask("two notes");

    const responses = await Promise.all([
      upload(taskId, "a.m4a", "audio/mp4"),
      upload(taskId, "b.m4a", "audio/mp4"),
    ]);

    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const text = (await getTaskById(taskId))!.task;
    expect(text).toContain("[Transcript of a.m4a]");
    expect(text).toContain("[Transcript of b.m4a]");
  });

  test("without a transcription provider the task gets one line saying so", async () => {
    const taskId = await draftTask("listen to this");

    const res = await upload(taskId, "memo.ogg", "audio/ogg");

    expect(res.status).toBe(201);
    expect(sttFilenames).toEqual([]);
    expect((await getTaskById(taskId))!.task).toBe(
      `listen to this\n\n[File: memo.ogg (audio/ogg)]\n${NO_PROVIDER}`,
    );
  });

  test("a failed transcription still stores the upload and says why", async () => {
    useTranscription();
    sttMode = "fail";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const taskId = await draftTask("listen to this");
    try {
      const res = await upload(taskId, "memo.ogg", "audio/ogg");
      expect(res.status).toBe(201);
    } finally {
      warn.mockRestore();
    }

    expect((await getTaskById(taskId))!.task).toContain(
      "[File: memo.ogg (audio/ogg)]\n(transcription failed: upstream overloaded)",
    );
    expect(await getTaskAttachments(taskId)).toHaveLength(1);
  });

  test("a task out of draft and a non-audio file are left as they are", async () => {
    useTranscription();
    const running = (await createTaskExtended("already dispatched", { agentId, source: "ui" })).id;
    const draft = await draftTask("a picture");

    expect((await upload(running, "late.ogg", "audio/ogg")).status).toBe(201);
    expect((await upload(draft, "shot.png", "image/png")).status).toBe(201);

    expect(sttFilenames).toEqual([]);
    expect((await getTaskById(running))!.task).toBe("already dispatched");
    expect((await getTaskById(draft))!.task).toBe("a picture");
  });
});

describe("Slack inbound files", () => {
  function slackFile(id: string, name: string, extra: Partial<SlackFile> = {}): SlackFile {
    return {
      id,
      name,
      mimetype: "audio/webm",
      filetype: "webm",
      size: AUDIO.byteLength,
      url_private: `${slackHost.url}files-pri/T0TEAM-${id}/${name}`,
      url_private_download: `${slackHost.url}files-pri/T0TEAM-${id}/download/${name}`,
      ...extra,
    };
  }
  const client = { token: BOT_TOKEN } as never;

  /** What the Slack handlers do: fetch, build the task text, create the task. */
  async function slackTask(text: string, files: SlackFile[]) {
    await using inbound = await fetchSlackFiles(client, files, { transcribe: true });
    const description = buildEffectiveText(text, inbound.files, inbound.failed, inbound.notes);
    return (await createSlackTaskWithFiles(description, { agentId, source: "slack" }, inbound))
      .task;
  }

  test("a voice clip gets its transcript under its file line and stays attached", async () => {
    useTranscription();
    // Slack voice clips are `slack_audio`, whatever their MIME type says.
    const clip = slackFile("F0CLIP0001", "audio_message.mp4", {
      mimetype: "video/mp4",
      subtype: "slack_audio",
    });

    const task = await slackTask("please do this", [clip]);

    expect(task.task).toBe(
      `please do this\n\n[File: audio_message.mp4 (video/mp4, 9 B) id=F0CLIP0001]\n[Transcript of audio_message.mp4]\nShip the release notes today.`,
    );
    expect((await getTaskById(task.id))!.status).toBe("pending");
    expect(await getTaskAttachments(task.id)).toHaveLength(1);
  });

  test("an audio file without a provider gets one line saying so", async () => {
    const task = await slackTask("", [slackFile("F0AUDIO002", "memo.webm")]);

    expect(task.task).toBe(`[File: memo.webm (audio/webm, 9 B) id=F0AUDIO002]\n${NO_PROVIDER}`);
    expect(sttFilenames).toEqual([]);
    expect(await getTaskAttachments(task.id)).toHaveLength(1);
  });

  test("a failed transcription never blocks the task", async () => {
    useTranscription();
    sttMode = "fail";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let task: Awaited<ReturnType<typeof slackTask>>;
    try {
      task = await slackTask("hi", [slackFile("F0AUDIO003", "memo.webm")]);
    } finally {
      warn.mockRestore();
    }

    expect(task.task).toContain(
      "[File: memo.webm (audio/webm, 9 B) id=F0AUDIO003]\n(transcription failed: upstream overloaded)",
    );
    expect((await getTaskById(task.id))!.status).toBe("pending");
  });

  test("an agent's own file fetch and non-audio files are not transcribed", async () => {
    useTranscription();
    await using fetched = await fetchSlackFiles(client, [slackFile("F0AUDIO004", "memo.webm")]);
    expect(fetched.notes).toBeUndefined();

    const task = await slackTask("see image", [
      slackFile("F0IMAGE005", "shot.png", { mimetype: "image/png", filetype: "png" }),
    ]);
    expect(task.task).not.toContain("Transcript");
    expect(sttFilenames).toEqual([]);
  });
});
