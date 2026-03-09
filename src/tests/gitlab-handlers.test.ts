import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  findTaskByVcs,
  getTaskById,
  initDb,
} from "../be/db";
import { GITLAB_BOT_NAME } from "../gitlab/auth";
import { handleIssue, handleMergeRequest, handleNote, handlePipeline } from "../gitlab/handlers";
import type { IssueEvent, MergeRequestEvent, NoteEvent, PipelineEvent } from "../gitlab/types";

const TEST_DB_PATH = "./test-gitlab-handlers.sqlite";

// ── Helpers ──

function makeMREvent(overrides: Partial<MergeRequestEvent> = {}): MergeRequestEvent {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: { id: 1, name: "Test User", username: "testuser", avatar_url: "" },
    project: {
      id: 1,
      name: "project",
      path_with_namespace: "group/project",
      web_url: "https://gitlab.com/group/project",
      default_branch: "main",
    },
    object_attributes: {
      id: 100,
      iid: 1,
      title: "Test MR",
      description: `@${GITLAB_BOT_NAME} please review`,
      state: "opened",
      action: "open",
      source_branch: "feature",
      target_branch: "main",
      url: "https://gitlab.com/group/project/-/merge_requests/1",
      last_commit: { id: "abc123", message: "test commit" },
      author_id: 1,
    },
    ...overrides,
  };
}

function makeIssueEvent(overrides: Partial<IssueEvent> = {}): IssueEvent {
  return {
    object_kind: "issue",
    event_type: "issue",
    user: { id: 1, name: "Test User", username: "testuser", avatar_url: "" },
    project: {
      id: 1,
      name: "project",
      path_with_namespace: "group/project",
      web_url: "https://gitlab.com/group/project",
      default_branch: "main",
    },
    object_attributes: {
      id: 200,
      iid: 10,
      title: "Test Issue",
      description: `@${GITLAB_BOT_NAME} fix this`,
      state: "opened",
      action: "open",
      url: "https://gitlab.com/group/project/-/issues/10",
      author_id: 1,
    },
    ...overrides,
  };
}

function makeNoteEvent(overrides: Partial<NoteEvent> = {}): NoteEvent {
  return {
    object_kind: "note",
    event_type: "note",
    user: { id: 1, name: "Test User", username: "testuser", avatar_url: "" },
    project: {
      id: 1,
      name: "project",
      path_with_namespace: "group/project",
      web_url: "https://gitlab.com/group/project",
      default_branch: "main",
    },
    object_attributes: {
      id: 300,
      note: `@${GITLAB_BOT_NAME} can you help?`,
      noteable_type: "MergeRequest",
      noteable_id: 100,
      url: "https://gitlab.com/group/project/-/merge_requests/1#note_300",
      author_id: 1,
      type: null,
    },
    merge_request: {
      id: 100,
      iid: 1,
      title: "Test MR",
      description: "test",
      state: "opened",
      action: "open",
      source_branch: "feature",
      target_branch: "main",
      url: "https://gitlab.com/group/project/-/merge_requests/1",
      last_commit: null,
      author_id: 1,
    },
    ...overrides,
  };
}

function makePipelineEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    object_kind: "pipeline",
    event_type: "pipeline",
    user: { id: 1, name: "Test User", username: "testuser", avatar_url: "" },
    project: {
      id: 1,
      name: "project",
      path_with_namespace: "group/project",
      web_url: "https://gitlab.com/group/project",
      default_branch: "main",
    },
    object_attributes: {
      id: 400,
      ref: "feature",
      status: "failed",
      source: "push",
      detailed_status: "failed",
    },
    merge_request: {
      id: 100,
      iid: 1,
      title: "Test MR",
      url: "https://gitlab.com/group/project/-/merge_requests/1",
      source_branch: "feature",
      target_branch: "main",
    },
    ...overrides,
  };
}

// ── Setup / Teardown ──

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);

  createAgent({
    id: "lead-gl-001",
    name: "GitLabTestLead",
    status: "idle",
    isLead: true,
  });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

// ═══════════════════════════════════════════════════════
// handleMergeRequest
// ═══════════════════════════════════════════════════════

describe("handleMergeRequest", () => {
  test("creates a task when MR is opened with bot mention", async () => {
    const event = makeMREvent({
      object_attributes: {
        id: 101,
        iid: 50,
        title: "MR with mention",
        description: `@${GITLAB_BOT_NAME} review this please`,
        state: "opened",
        action: "open",
        source_branch: "feat-a",
        target_branch: "main",
        url: "https://gitlab.com/group/project/-/merge_requests/50",
        last_commit: null,
        author_id: 1,
      },
    });

    const result = await handleMergeRequest(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();

    // Verify task has correct vcs fields
    const task = getTaskById(result.taskId!);
    expect(task).not.toBeNull();
    expect(task?.source).toBe("gitlab");
    expect(task?.vcsProvider).toBe("gitlab");
    expect(task?.vcsRepo).toBe("group/project");
    expect(task?.vcsNumber).toBe(50);
    expect(task?.vcsEventType).toBe("merge_request");
  });

  test("skips MR opened without bot mention", async () => {
    const event = makeMREvent({
      object_attributes: {
        id: 102,
        iid: 51,
        title: "MR without mention",
        description: "Just a regular MR",
        state: "opened",
        action: "open",
        source_branch: "feat-b",
        target_branch: "main",
        url: "https://gitlab.com/group/project/-/merge_requests/51",
        last_commit: null,
        author_id: 1,
      },
    });

    const result = await handleMergeRequest(event);
    expect(result.created).toBe(false);
  });

  test("cancels task when MR is closed", async () => {
    // Create an active task for MR #60
    createTaskExtended("[GitLab MR #60] Test", {
      source: "gitlab",
      vcsProvider: "gitlab",
      vcsRepo: "group/project",
      vcsEventType: "merge_request",
      vcsNumber: 60,
      vcsAuthor: "testuser",
      vcsUrl: "https://gitlab.com/group/project/-/merge_requests/60",
      agentId: "lead-gl-001",
    });

    const existing = findTaskByVcs("group/project", 60);
    expect(existing).not.toBeNull();

    const event = makeMREvent({
      object_attributes: {
        id: 103,
        iid: 60,
        title: "MR to close",
        description: null,
        state: "closed",
        action: "close",
        source_branch: "feat-c",
        target_branch: "main",
        url: "https://gitlab.com/group/project/-/merge_requests/60",
        last_commit: null,
        author_id: 1,
      },
    });

    const result = await handleMergeRequest(event);
    expect(result.created).toBe(false);

    // Task should be failed/cancelled
    const task = getTaskById(existing!.id);
    expect(task?.status).toBe("failed");
  });

  test("cancels task when MR is merged", async () => {
    createTaskExtended("[GitLab MR #61] Test merge", {
      source: "gitlab",
      vcsProvider: "gitlab",
      vcsRepo: "group/project",
      vcsEventType: "merge_request",
      vcsNumber: 61,
      vcsUrl: "https://gitlab.com/group/project/-/merge_requests/61",
      agentId: "lead-gl-001",
    });

    const event = makeMREvent({
      object_attributes: {
        id: 104,
        iid: 61,
        title: "MR to merge",
        description: null,
        state: "merged",
        action: "merge",
        source_branch: "feat-d",
        target_branch: "main",
        url: "https://gitlab.com/group/project/-/merge_requests/61",
        last_commit: null,
        author_id: 1,
      },
    });

    const result = await handleMergeRequest(event);
    expect(result.created).toBe(false);

    const existing = findTaskByVcs("group/project", 61);
    // Should no longer be active (findTaskByVcs filters out completed/failed)
    expect(existing).toBeNull();
  });

  test("ignores update action when no active task", async () => {
    const event = makeMREvent({
      object_attributes: {
        id: 105,
        iid: 62,
        title: "Updated MR",
        description: `@${GITLAB_BOT_NAME} review`,
        state: "opened",
        action: "update",
        source_branch: "feat-e",
        target_branch: "main",
        url: "https://gitlab.com/group/project/-/merge_requests/62",
        last_commit: null,
        author_id: 1,
      },
    });

    const result = await handleMergeRequest(event);
    expect(result.created).toBe(false);
  });

  test("deduplicates identical MR events", async () => {
    const event = makeMREvent({
      object_attributes: {
        id: 106,
        iid: 70,
        title: "Dedup MR",
        description: `@${GITLAB_BOT_NAME} review`,
        state: "opened",
        action: "open",
        source_branch: "feat-dedup",
        target_branch: "main",
        url: "https://gitlab.com/group/project/-/merge_requests/70",
        last_commit: null,
        author_id: 1,
      },
    });

    const first = await handleMergeRequest(event);
    expect(first.created).toBe(true);

    // Same event again should be deduped
    const second = await handleMergeRequest(event);
    expect(second.created).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// handleIssue
// ═══════════════════════════════════════════════════════

describe("handleIssue", () => {
  test("creates a task when issue is opened with bot mention", async () => {
    const event = makeIssueEvent({
      object_attributes: {
        id: 201,
        iid: 20,
        title: "Issue with mention",
        description: `@${GITLAB_BOT_NAME} implement this feature`,
        state: "opened",
        action: "open",
        url: "https://gitlab.com/group/project/-/issues/20",
        author_id: 1,
      },
    });

    const result = await handleIssue(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();

    const task = getTaskById(result.taskId!);
    expect(task?.source).toBe("gitlab");
    expect(task?.vcsProvider).toBe("gitlab");
    expect(task?.vcsNumber).toBe(20);
    expect(task?.vcsEventType).toBe("issue");
  });

  test("creates a task when bot is assigned to issue", async () => {
    const event = makeIssueEvent({
      object_attributes: {
        id: 202,
        iid: 21,
        title: "Issue with assignment",
        description: "No mention here",
        state: "opened",
        action: "open",
        url: "https://gitlab.com/group/project/-/issues/21",
        author_id: 1,
      },
      assignees: [{ id: 99, name: "Bot", username: GITLAB_BOT_NAME, avatar_url: "" }],
    });

    const result = await handleIssue(event);
    expect(result.created).toBe(true);
  });

  test("skips issue without bot mention or assignment", async () => {
    const event = makeIssueEvent({
      object_attributes: {
        id: 203,
        iid: 22,
        title: "Issue without mention",
        description: "Just a regular issue",
        state: "opened",
        action: "open",
        url: "https://gitlab.com/group/project/-/issues/22",
        author_id: 1,
      },
    });

    const result = await handleIssue(event);
    expect(result.created).toBe(false);
  });

  test("cancels task when issue is closed", async () => {
    createTaskExtended("[GitLab Issue #30] Test close", {
      source: "gitlab",
      vcsProvider: "gitlab",
      vcsRepo: "group/project",
      vcsEventType: "issue",
      vcsNumber: 30,
      vcsUrl: "https://gitlab.com/group/project/-/issues/30",
      agentId: "lead-gl-001",
    });

    const event = makeIssueEvent({
      object_attributes: {
        id: 204,
        iid: 30,
        title: "Closed issue",
        description: null,
        state: "closed",
        action: "close",
        url: "https://gitlab.com/group/project/-/issues/30",
        author_id: 1,
      },
    });

    const result = await handleIssue(event);
    expect(result.created).toBe(false);

    // Task should no longer be active
    const task = findTaskByVcs("group/project", 30);
    expect(task).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// handleNote
// ═══════════════════════════════════════════════════════

describe("handleNote", () => {
  test("creates a task for note with bot mention on MR", async () => {
    const event = makeNoteEvent({
      object_attributes: {
        id: 301,
        note: `@${GITLAB_BOT_NAME} please check this code`,
        noteable_type: "MergeRequest",
        noteable_id: 100,
        url: "https://gitlab.com/group/project/-/merge_requests/1#note_301",
        author_id: 1,
        type: null,
      },
      merge_request: {
        id: 100,
        iid: 80,
        title: "MR for note",
        description: "test",
        state: "opened",
        action: "open",
        source_branch: "feat",
        target_branch: "main",
        url: "https://gitlab.com/group/project/-/merge_requests/80",
        last_commit: null,
        author_id: 1,
      },
    });

    const result = await handleNote(event);
    expect(result.created).toBe(true);

    const task = getTaskById(result.taskId!);
    expect(task?.vcsProvider).toBe("gitlab");
    expect(task?.vcsEventType).toBe("note_on_mr");
    expect(task?.vcsNumber).toBe(80);
  });

  test("creates a task for note with bot mention on issue", async () => {
    const event = makeNoteEvent({
      object_attributes: {
        id: 302,
        note: `@${GITLAB_BOT_NAME} what do you think?`,
        noteable_type: "Issue",
        noteable_id: 200,
        url: "https://gitlab.com/group/project/-/issues/40#note_302",
        author_id: 1,
        type: null,
      },
      merge_request: undefined,
      issue: {
        id: 200,
        iid: 40,
        title: "Issue for note",
        description: "test issue",
        state: "opened",
        action: "open",
        url: "https://gitlab.com/group/project/-/issues/40",
        author_id: 1,
      },
    });

    const result = await handleNote(event);
    expect(result.created).toBe(true);

    const task = getTaskById(result.taskId!);
    expect(task?.vcsEventType).toBe("note_on_issue");
    expect(task?.vcsNumber).toBe(40);
  });

  test("skips note without bot mention", async () => {
    const event = makeNoteEvent({
      object_attributes: {
        id: 303,
        note: "This is a regular comment without mentioning the bot",
        noteable_type: "MergeRequest",
        noteable_id: 100,
        url: "https://gitlab.com/group/project/-/merge_requests/1#note_303",
        author_id: 1,
        type: null,
      },
    });

    const result = await handleNote(event);
    expect(result.created).toBe(false);
  });

  test("ignores note on unsupported noteable types", async () => {
    const event = makeNoteEvent({
      object_attributes: {
        id: 304,
        note: `@${GITLAB_BOT_NAME} review this commit`,
        noteable_type: "Commit",
        noteable_id: 999,
        url: "https://gitlab.com/group/project/-/commit/abc#note_304",
        author_id: 1,
        type: null,
      },
      merge_request: undefined,
      issue: undefined,
    });

    const result = await handleNote(event);
    expect(result.created).toBe(false);
  });

  test("links to existing task when commenting on entity with active task", async () => {
    // Create active task for MR #85
    createTaskExtended("[GitLab MR #85] Existing", {
      source: "gitlab",
      vcsProvider: "gitlab",
      vcsRepo: "group/project",
      vcsEventType: "merge_request",
      vcsNumber: 85,
      vcsUrl: "https://gitlab.com/group/project/-/merge_requests/85",
      agentId: "lead-gl-001",
    });

    const event = makeNoteEvent({
      object_attributes: {
        id: 305,
        note: `@${GITLAB_BOT_NAME} also fix the linting`,
        noteable_type: "MergeRequest",
        noteable_id: 100,
        url: "https://gitlab.com/group/project/-/merge_requests/85#note_305",
        author_id: 1,
        type: null,
      },
      merge_request: {
        id: 100,
        iid: 85,
        title: "MR with existing task",
        description: "",
        state: "opened",
        action: "open",
        source_branch: "feat",
        target_branch: "main",
        url: "https://gitlab.com/group/project/-/merge_requests/85",
        last_commit: null,
        author_id: 1,
      },
    });

    const result = await handleNote(event);
    expect(result.created).toBe(true);

    const task = getTaskById(result.taskId!);
    // Should have parentTaskId linking to existing task
    expect(task?.parentTaskId).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════
// handlePipeline
// ═══════════════════════════════════════════════════════

describe("handlePipeline", () => {
  test("creates task for failed pipeline with active MR task", async () => {
    // Create active task for MR #90
    createTaskExtended("[GitLab MR #90] Pipeline test", {
      source: "gitlab",
      vcsProvider: "gitlab",
      vcsRepo: "group/project",
      vcsEventType: "merge_request",
      vcsNumber: 90,
      vcsUrl: "https://gitlab.com/group/project/-/merge_requests/90",
      agentId: "lead-gl-001",
    });

    const event = makePipelineEvent({
      object_attributes: {
        id: 401,
        ref: "feature",
        status: "failed",
        source: "push",
        detailed_status: "failed",
      },
      merge_request: {
        id: 100,
        iid: 90,
        title: "MR with pipeline",
        url: "https://gitlab.com/group/project/-/merge_requests/90",
        source_branch: "feature",
        target_branch: "main",
      },
    });

    const result = await handlePipeline(event);
    expect(result.created).toBe(true);

    const task = getTaskById(result.taskId!);
    expect(task?.vcsProvider).toBe("gitlab");
    expect(task?.vcsEventType).toBe("pipeline");
    expect(task?.parentTaskId).toBeDefined();
  });

  test("skips successful pipeline", async () => {
    const event = makePipelineEvent({
      object_attributes: {
        id: 402,
        ref: "feature",
        status: "success",
        source: "push",
        detailed_status: "passed",
      },
    });

    const result = await handlePipeline(event);
    expect(result.created).toBe(false);
  });

  test("skips failed pipeline without associated MR", async () => {
    const event = makePipelineEvent({
      merge_request: undefined,
    });

    const result = await handlePipeline(event);
    expect(result.created).toBe(false);
  });

  test("skips failed pipeline when no active task for MR", async () => {
    const event = makePipelineEvent({
      object_attributes: {
        id: 403,
        ref: "feature",
        status: "failed",
        source: "push",
        detailed_status: "failed",
      },
      merge_request: {
        id: 999,
        iid: 999,
        title: "MR without task",
        url: "https://gitlab.com/group/project/-/merge_requests/999",
        source_branch: "no-task",
        target_branch: "main",
      },
    });

    const result = await handlePipeline(event);
    expect(result.created).toBe(false);
  });
});
