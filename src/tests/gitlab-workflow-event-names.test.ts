import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

process.env.GITLAB_WEBHOOK_SECRET = "s3cret";

const { closeDb, initDb } = await import("../be/db");
const { initGitLab, resetGitLab } = await import("../gitlab/auth");
const { handleWebhooks } = await import("../http/webhooks");
const { workflowEventBus } = await import("../workflows/event-bus");

const DB = "./gitlab-workflow-event-names.sqlite";

beforeAll(() => {
  initDb(DB);
  resetGitLab();
  initGitLab();
});

afterAll(async () => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) {
    await unlink(DB + s).catch(() => {});
  }
  resetGitLab();
});

function post(body: unknown) {
  const raw = JSON.stringify(body);
  const req = {
    method: "POST",
    headers: { "x-gitlab-token": "s3cret" },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(raw);
    },
  } as unknown as IncomingMessage;
  const res = {
    writeHead: () => res,
    end: () => res,
  } as unknown as ServerResponse;
  return handleWebhooks(req, res, ["api", "gitlab", "webhook"]);
}

const user = { id: 1, name: "U", username: "u", avatar_url: "" };
const project = {
  id: 1,
  name: "p",
  path_with_namespace: "g/p",
  web_url: "https://gitlab.com/g/p",
  default_branch: "main",
};

const mr = (action: string, state: string) => ({
  object_kind: "merge_request",
  event_type: "merge_request",
  user,
  project,
  object_attributes: {
    id: 1,
    iid: 1,
    title: "t",
    description: "",
    state,
    action,
    source_branch: "f",
    target_branch: "main",
    url: "u",
    author_id: 1,
    last_commit: null,
  },
});

const issue = (action: string, state: string) => ({
  object_kind: "issue",
  event_type: "issue",
  user,
  project,
  object_attributes: {
    id: 2,
    iid: 2,
    title: "t",
    description: "",
    state,
    action,
    url: "u",
    author_id: 1,
  },
});

let emitted: string[] = [];
let originalEmit: typeof workflowEventBus.emit;

beforeEach(() => {
  emitted = [];
  originalEmit = workflowEventBus.emit.bind(workflowEventBus);
  workflowEventBus.emit = ((name: string) => {
    emitted.push(name);
  }) as typeof workflowEventBus.emit;
});

afterEach(() => {
  workflowEventBus.emit = originalEmit;
});

describe("GitLab workflow event names", () => {
  test("documented past-tense names are emitted (and raw names kept for compatibility)", async () => {
    await post(mr("open", "opened"));
    await post(mr("merge", "merged"));
    await post(mr("close", "closed"));
    await post(issue("open", "opened"));
    await post(issue("close", "closed"));

    const documented = [
      "gitlab.merge_request.opened",
      "gitlab.merge_request.merged",
      "gitlab.merge_request.closed",
      "gitlab.issue.opened",
      "gitlab.issue.closed",
    ];
    for (const name of documented) {
      expect(emitted).toContain(name);
    }

    expect(emitted).toContain("gitlab.merge_request.open");
    expect(emitted).toContain("gitlab.merge_request.merge");
    expect(emitted).toContain("gitlab.merge_request.close");
    expect(emitted).toContain("gitlab.issue.open");
    expect(emitted).toContain("gitlab.issue.close");
  });

  test("unmapped actions emit once under their raw name", async () => {
    await post(mr("update", "opened"));
    expect(emitted).toContain("gitlab.merge_request.update");
    expect(emitted.filter((n) => n.startsWith("gitlab.merge_request.")).length).toBe(1);
  });
});
