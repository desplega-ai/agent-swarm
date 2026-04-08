import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentTask } from "../types";

// ── Mocks ──

const mockAddReaction = mock(() => Promise.resolve(true));
const mockAddPullReviewCommentReaction = mock(() => Promise.resolve(true));
const mockAddGraphQLReaction = mock(() => Promise.resolve(true));
const mockAddIssueReaction = mock(() => Promise.resolve(true));

mock.module("../github/reactions", () => ({
  addReaction: mockAddReaction,
  addPullReviewCommentReaction: mockAddPullReviewCommentReaction,
  addGraphQLReaction: mockAddGraphQLReaction,
  addIssueReaction: mockAddIssueReaction,
}));

// Import after mocking
const { addEyesReactionOnTaskStart } = await import("../github/task-reactions");

// ── Helpers ──

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    agentId: "11111111-2222-3333-4444-555555555555",
    task: "Test task",
    status: "in_progress",
    source: "github",
    vcsProvider: "github",
    vcsRepo: "desplega-ai/agent-swarm",
    vcsInstallationId: 12345,
    vcsEventType: "issue_comment",
    priority: 50,
    tags: [],
    dependsOn: [],
    wasPaused: false,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  } as AgentTask;
}

// ── Tests ──

describe("addEyesReactionOnTaskStart", () => {
  beforeEach(() => {
    mockAddReaction.mockClear();
    mockAddPullReviewCommentReaction.mockClear();
    mockAddGraphQLReaction.mockClear();
    mockAddIssueReaction.mockClear();
  });

  // ── Early bail-out cases ──

  test("skips when source is not github", async () => {
    await addEyesReactionOnTaskStart(makeTask({ source: "slack" }));
    expect(mockAddReaction).not.toHaveBeenCalled();
    expect(mockAddPullReviewCommentReaction).not.toHaveBeenCalled();
    expect(mockAddGraphQLReaction).not.toHaveBeenCalled();
    expect(mockAddIssueReaction).not.toHaveBeenCalled();
  });

  test("skips when vcsProvider is not github", async () => {
    await addEyesReactionOnTaskStart(makeTask({ vcsProvider: "gitlab" }));
    expect(mockAddReaction).not.toHaveBeenCalled();
    expect(mockAddPullReviewCommentReaction).not.toHaveBeenCalled();
    expect(mockAddGraphQLReaction).not.toHaveBeenCalled();
    expect(mockAddIssueReaction).not.toHaveBeenCalled();
  });

  test("skips when vcsInstallationId is missing", async () => {
    await addEyesReactionOnTaskStart(makeTask({ vcsInstallationId: undefined }));
    expect(mockAddReaction).not.toHaveBeenCalled();
    expect(mockAddPullReviewCommentReaction).not.toHaveBeenCalled();
    expect(mockAddGraphQLReaction).not.toHaveBeenCalled();
    expect(mockAddIssueReaction).not.toHaveBeenCalled();
  });

  // ── issue_comment ──

  test("issue_comment with vcsCommentId calls addReaction", async () => {
    await addEyesReactionOnTaskStart(makeTask({ vcsEventType: "issue_comment", vcsCommentId: 42 }));
    expect(mockAddReaction).toHaveBeenCalledTimes(1);
    expect(mockAddReaction).toHaveBeenCalledWith("desplega-ai/agent-swarm", 42, "eyes", 12345);
  });

  test("issue_comment without vcsCommentId is a no-op", async () => {
    await addEyesReactionOnTaskStart(
      makeTask({ vcsEventType: "issue_comment", vcsCommentId: undefined }),
    );
    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  // ── pull_request_review_comment ──

  test("pull_request_review_comment with vcsCommentId calls addPullReviewCommentReaction", async () => {
    await addEyesReactionOnTaskStart(
      makeTask({ vcsEventType: "pull_request_review_comment", vcsCommentId: 99 }),
    );
    expect(mockAddPullReviewCommentReaction).toHaveBeenCalledTimes(1);
    expect(mockAddPullReviewCommentReaction).toHaveBeenCalledWith(
      "desplega-ai/agent-swarm",
      99,
      "eyes",
      12345,
    );
  });

  test("pull_request_review_comment without vcsCommentId is a no-op", async () => {
    await addEyesReactionOnTaskStart(
      makeTask({ vcsEventType: "pull_request_review_comment", vcsCommentId: undefined }),
    );
    expect(mockAddPullReviewCommentReaction).not.toHaveBeenCalled();
  });

  // ── pull_request_review ──

  test("pull_request_review with vcsNodeId calls addGraphQLReaction with EYES", async () => {
    await addEyesReactionOnTaskStart(
      makeTask({ vcsEventType: "pull_request_review", vcsNodeId: "PRR_abc123" }),
    );
    expect(mockAddGraphQLReaction).toHaveBeenCalledTimes(1);
    expect(mockAddGraphQLReaction).toHaveBeenCalledWith("PRR_abc123", "EYES", 12345);
  });

  test("pull_request_review without vcsNodeId is a no-op", async () => {
    await addEyesReactionOnTaskStart(
      makeTask({ vcsEventType: "pull_request_review", vcsNodeId: undefined }),
    );
    expect(mockAddGraphQLReaction).not.toHaveBeenCalled();
  });

  // ── pull_request ──

  test("pull_request with vcsNumber calls addIssueReaction", async () => {
    await addEyesReactionOnTaskStart(makeTask({ vcsEventType: "pull_request", vcsNumber: 310 }));
    expect(mockAddIssueReaction).toHaveBeenCalledTimes(1);
    expect(mockAddIssueReaction).toHaveBeenCalledWith(
      "desplega-ai/agent-swarm",
      310,
      "eyes",
      12345,
    );
  });

  test("pull_request without vcsNumber is a no-op", async () => {
    await addEyesReactionOnTaskStart(
      makeTask({ vcsEventType: "pull_request", vcsNumber: undefined }),
    );
    expect(mockAddIssueReaction).not.toHaveBeenCalled();
  });

  // ── issues ──

  test("issues with vcsNumber calls addIssueReaction", async () => {
    await addEyesReactionOnTaskStart(makeTask({ vcsEventType: "issues", vcsNumber: 55 }));
    expect(mockAddIssueReaction).toHaveBeenCalledTimes(1);
    expect(mockAddIssueReaction).toHaveBeenCalledWith("desplega-ai/agent-swarm", 55, "eyes", 12345);
  });

  test("issues without vcsNumber is a no-op", async () => {
    await addEyesReactionOnTaskStart(makeTask({ vcsEventType: "issues", vcsNumber: undefined }));
    expect(mockAddIssueReaction).not.toHaveBeenCalled();
  });

  // ── Error handling ──

  test("swallows errors from reaction functions without throwing", async () => {
    mockAddReaction.mockImplementationOnce(() => Promise.reject(new Error("Network error")));
    await expect(
      addEyesReactionOnTaskStart(makeTask({ vcsEventType: "issue_comment", vcsCommentId: 1 })),
    ).resolves.toBeUndefined();
  });
});
