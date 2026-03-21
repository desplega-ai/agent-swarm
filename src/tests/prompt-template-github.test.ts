import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb, upsertPromptTemplate } from "../be/db";
import {
  clearTemplateDefinitions,
  getAllTemplateDefinitions,
  getTemplateDefinition,
} from "../prompts/registry";
import { resolveTemplate } from "../prompts/resolver";
// Side-effect import: registers all GitHub templates
import "../github/templates";

async function ensureTemplatesRegistered(): Promise<void> {
  if (getTemplateDefinition("github.pull_request.assigned")) return;
  const ts = Date.now();
  await import(`../github/templates?t=${ts}`);
}

const TEST_DB_PATH = "./test-prompt-github.sqlite";

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File doesn't exist
    }
  }
  initDb(TEST_DB_PATH);
});

beforeEach(async () => {
  await ensureTemplatesRegistered();
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File doesn't exist
    }
  }
});

// ============================================================================
// Registration verification
// ============================================================================

describe("GitHub template registration", () => {
  test("all 16 templates are registered (12 event + 4 common)", () => {
    const all = getAllTemplateDefinitions();
    const eventTypes = all.map((d) => d.eventType).sort();
    expect(eventTypes).toContain("common.delegation_instruction");
    expect(eventTypes).toContain("common.command_suggestions.github_pr");
    expect(eventTypes).toContain("common.command_suggestions.github_issue");
    expect(eventTypes).toContain("common.command_suggestions.github_comment_pr");
    expect(eventTypes).toContain("common.command_suggestions.github_comment_issue");
    expect(eventTypes).toContain("github.pull_request.assigned");
    expect(eventTypes).toContain("github.pull_request.review_requested");
    expect(eventTypes).toContain("github.pull_request.closed");
    expect(eventTypes).toContain("github.pull_request.synchronize");
    expect(eventTypes).toContain("github.pull_request.mentioned");
    expect(eventTypes).toContain("github.issue.assigned");
    expect(eventTypes).toContain("github.issue.mentioned");
    expect(eventTypes).toContain("github.comment.mentioned");
    expect(eventTypes).toContain("github.pull_request.review_submitted");
    expect(eventTypes).toContain("github.check_run.failed");
    expect(eventTypes).toContain("github.check_suite.failed");
    expect(eventTypes).toContain("github.workflow_run.failed");
  });
});

// ============================================================================
// Backward compatibility: byte-identical output
// ============================================================================

describe("backward compatibility — byte-identical output", () => {
  // -- PR assigned --
  test("github.pull_request.assigned produces expected output", () => {
    const result = resolveTemplate("github.pull_request.assigned", {
      pr_number: 42,
      pr_title: "Fix bug",
      bot_name: "agent-swarm-bot",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      head_ref: "feature",
      base_ref: "main",
      pr_url: "https://github.com/owner/repo/pull/42",
      context: "Some PR body text",
    });

    expect(result.skipped).toBe(false);
    expect(result.unresolved.length).toBe(0);

    const expected = `[GitHub PR #42] Fix bug

Assigned to: @agent-swarm-bot
From: alice
Repo: owner/repo
Branch: feature \u2192 main
URL: https://github.com/owner/repo/pull/42

Context:
Some PR body text

---
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: /review-pr or /respond-github`;

    expect(result.text).toBe(expected);
  });

  // -- PR review requested --
  test("github.pull_request.review_requested produces expected output", () => {
    const result = resolveTemplate("github.pull_request.review_requested", {
      pr_number: 42,
      pr_title: "Fix bug",
      bot_name: "agent-swarm-bot",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      head_ref: "feature",
      base_ref: "main",
      pr_url: "https://github.com/owner/repo/pull/42",
      context: "Fix bug",
    });

    expect(result.skipped).toBe(false);

    const expected = `[GitHub PR #42] Fix bug

Review requested from: @agent-swarm-bot
From: alice
Repo: owner/repo
Branch: feature \u2192 main
URL: https://github.com/owner/repo/pull/42

Context:
Fix bug

---
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: /review-pr or /respond-github`;

    expect(result.text).toBe(expected);
  });

  // -- PR closed (merged) --
  test("github.pull_request.closed (merged) produces expected output", () => {
    const result = resolveTemplate("github.pull_request.closed", {
      status_emoji: "\ud83c\udf89",
      pr_number: 42,
      status: "MERGED",
      merged_by: " by bob",
      pr_title: "Fix bug",
      repo_full_name: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/42",
      related_task_id: "task-123",
      follow_up_suggestion:
        "\ud83d\udca1 PR successfully merged! Update any related issues or documentation.",
    });

    expect(result.skipped).toBe(false);

    const expected = `\ud83c\udf89 [GitHub PR #42] MERGED by bob

PR: Fix bug
Repo: owner/repo
URL: https://github.com/owner/repo/pull/42

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 PR successfully merged! Update any related issues or documentation.`;

    expect(result.text).toBe(expected);
  });

  // -- PR closed (not merged) --
  test("github.pull_request.closed (not merged) produces expected output", () => {
    const result = resolveTemplate("github.pull_request.closed", {
      status_emoji: "\u274c",
      pr_number: 42,
      status: "CLOSED",
      merged_by: "",
      pr_title: "Fix bug",
      repo_full_name: "owner/repo",
      pr_url: "https://github.com/owner/repo/pull/42",
      related_task_id: "task-123",
      follow_up_suggestion:
        "\ud83d\udca1 PR was closed without merging. Review if follow-up is needed.",
    });

    expect(result.skipped).toBe(false);

    const expected = `\u274c [GitHub PR #42] CLOSED

PR: Fix bug
Repo: owner/repo
URL: https://github.com/owner/repo/pull/42

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 PR was closed without merging. Review if follow-up is needed.`;

    expect(result.text).toBe(expected);
  });

  // -- PR synchronize --
  test("github.pull_request.synchronize produces expected output", () => {
    const result = resolveTemplate("github.pull_request.synchronize", {
      pr_number: 42,
      pr_title: "Fix bug",
      repo_full_name: "owner/repo",
      head_ref: "feature",
      head_sha_short: "abc1234",
      pr_url: "https://github.com/owner/repo/pull/42",
      related_task_id: "task-123",
    });

    expect(result.skipped).toBe(false);

    const expected = `\ud83d\udd04 [GitHub PR #42] New commits pushed

PR: Fix bug
Repo: owner/repo
Branch: feature
New HEAD: abc1234
URL: https://github.com/owner/repo/pull/42

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 New commits were pushed. CI will re-run - monitor for results.`;

    expect(result.text).toBe(expected);
  });

  // -- PR mentioned --
  test("github.pull_request.mentioned produces expected output", () => {
    const result = resolveTemplate("github.pull_request.mentioned", {
      pr_number: 42,
      pr_title: "Fix bug",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      head_ref: "feature",
      base_ref: "main",
      pr_url: "https://github.com/owner/repo/pull/42",
      context: "Please review this PR",
    });

    expect(result.skipped).toBe(false);

    const expected = `[GitHub PR #42] Fix bug

From: alice
Repo: owner/repo
Branch: feature \u2192 main
URL: https://github.com/owner/repo/pull/42

Context:
Please review this PR

---
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: /review-pr or /respond-github`;

    expect(result.text).toBe(expected);
  });

  // -- Issue assigned --
  test("github.issue.assigned produces expected output", () => {
    const result = resolveTemplate("github.issue.assigned", {
      issue_number: 10,
      issue_title: "Bug report",
      bot_name: "agent-swarm-bot",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      issue_url: "https://github.com/owner/repo/issues/10",
      context: "Issue body text",
    });

    expect(result.skipped).toBe(false);

    const expected = `[GitHub Issue #10] Bug report

Assigned to: @agent-swarm-bot
From: alice
Repo: owner/repo
URL: https://github.com/owner/repo/issues/10

Context:
Issue body text

---
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: /implement-issue or /respond-github`;

    expect(result.text).toBe(expected);
  });

  // -- Issue mentioned --
  test("github.issue.mentioned produces expected output", () => {
    const result = resolveTemplate("github.issue.mentioned", {
      issue_number: 10,
      issue_title: "Bug report",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      issue_url: "https://github.com/owner/repo/issues/10",
      context: "Please look at this",
    });

    expect(result.skipped).toBe(false);

    const expected = `[GitHub Issue #10] Bug report

From: alice
Repo: owner/repo
URL: https://github.com/owner/repo/issues/10

Context:
Please look at this

---
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: /implement-issue or /respond-github`;

    expect(result.text).toBe(expected);
  });

  // -- Comment mentioned (PR, with existing task) --
  test("github.comment.mentioned (PR, with related task) produces expected output", () => {
    const result = resolveTemplate("github.comment.mentioned", {
      target_type: "PR",
      target_number: 42,
      target_title: "Fix bug",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      comment_url: "https://github.com/owner/repo/pull/42#issuecomment-123",
      context: "Can you fix this?",
      related_task_section:
        "Related task: task-123\n\ud83d\udd00 Consider routing to the same agent working on the related task.\n",
      command_suggestions: "\ud83d\udca1 Suggested: /respond-github or /review-pr",
    });

    expect(result.skipped).toBe(false);

    const expected = `[GitHub PR #42 Comment] Fix bug

From: alice
Repo: owner/repo
URL: https://github.com/owner/repo/pull/42#issuecomment-123

Comment:
Can you fix this?

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: /respond-github or /review-pr`;

    expect(result.text).toBe(expected);
  });

  // -- Comment mentioned (Issue, no existing task) --
  test("github.comment.mentioned (Issue, no related task) produces expected output", () => {
    const result = resolveTemplate("github.comment.mentioned", {
      target_type: "Issue",
      target_number: 10,
      target_title: "Bug report",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      comment_url: "https://github.com/owner/repo/issues/10#issuecomment-456",
      context: "Any update?",
      related_task_section: "",
      command_suggestions: "\ud83d\udca1 Suggested: /respond-github",
    });

    expect(result.skipped).toBe(false);

    const expected = `[GitHub Issue #10 Comment] Bug report

From: alice
Repo: owner/repo
URL: https://github.com/owner/repo/issues/10#issuecomment-456

Comment:
Any update?

---
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: /respond-github`;

    expect(result.text).toBe(expected);
  });

  // -- PR review submitted (approved, with existing task) --
  test("github.pull_request.review_submitted (approved, related task) produces expected output", () => {
    const result = resolveTemplate("github.pull_request.review_submitted", {
      review_emoji: "\u2705",
      pr_number: 42,
      review_label: "APPROVED",
      pr_title: "Fix bug",
      sender_login: "reviewer",
      repo_full_name: "owner/repo",
      review_url: "https://github.com/owner/repo/pull/42#pullrequestreview-789",
      review_body_section: "\n\nReview Comment:\nLooks good!",
      related_task_section:
        "Related task: task-123\n\ud83d\udd00 Consider routing to the same agent working on the related task.\n",
      review_suggestions: "\ud83d\udca1 Suggested: Merge the PR or wait for additional reviews",
    });

    expect(result.skipped).toBe(false);

    const expected = `\u2705 [GitHub PR #42 Review] APPROVED

PR: Fix bug
Reviewer: reviewer
Repo: owner/repo
URL: https://github.com/owner/repo/pull/42#pullrequestreview-789

Review Comment:
Looks good!

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: Merge the PR or wait for additional reviews`;

    expect(result.text).toBe(expected);
  });

  // -- PR review submitted (changes_requested, no review body, no existing task) --
  test("github.pull_request.review_submitted (changes_requested, no body, no related task) produces expected output", () => {
    const result = resolveTemplate("github.pull_request.review_submitted", {
      review_emoji: "\ud83d\udd04",
      pr_number: 42,
      review_label: "CHANGES REQUESTED",
      pr_title: "Fix bug",
      sender_login: "reviewer",
      repo_full_name: "owner/repo",
      review_url: "https://github.com/owner/repo/pull/42#pullrequestreview-789",
      review_body_section: "",
      related_task_section: "",
      review_suggestions: "\ud83d\udca1 Suggested: Address the requested changes and update the PR",
    });

    expect(result.skipped).toBe(false);

    const expected = `\ud83d\udd04 [GitHub PR #42 Review] CHANGES REQUESTED

PR: Fix bug
Reviewer: reviewer
Repo: owner/repo
URL: https://github.com/owner/repo/pull/42#pullrequestreview-789

---
\u26a0\ufe0f As lead, DELEGATE this task to a worker agent - do not tackle it yourself.
\ud83d\udca1 Suggested: Address the requested changes and update the PR`;

    expect(result.text).toBe(expected);
  });

  // -- Check run failed --
  test("github.check_run.failed produces expected output", () => {
    const result = resolveTemplate("github.check_run.failed", {
      conclusion_emoji: "\u274c",
      pr_number: 42,
      check_name: "lint",
      conclusion_label: "FAILED",
      repo_full_name: "owner/repo",
      check_url: "https://github.com/owner/repo/runs/123",
      output_summary_section: "\n\nSummary:\nLinting errors found",
      related_task_id: "task-123",
    });

    expect(result.skipped).toBe(false);

    const expected = `\u274c [GitHub PR #42 CI] lint FAILED

Repo: owner/repo
Check: lint
URL: https://github.com/owner/repo/runs/123

Summary:
Linting errors found

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 CI check failed. Review the logs and fix the issue.`;

    expect(result.text).toBe(expected);
  });

  // -- Check run failed (no summary) --
  test("github.check_run.failed (no summary) produces expected output", () => {
    const result = resolveTemplate("github.check_run.failed", {
      conclusion_emoji: "\u274c",
      pr_number: 42,
      check_name: "lint",
      conclusion_label: "FAILED",
      repo_full_name: "owner/repo",
      check_url: "https://github.com/owner/repo/runs/123",
      output_summary_section: "",
      related_task_id: "task-123",
    });

    expect(result.skipped).toBe(false);

    const expected = `\u274c [GitHub PR #42 CI] lint FAILED

Repo: owner/repo
Check: lint
URL: https://github.com/owner/repo/runs/123

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 CI check failed. Review the logs and fix the issue.`;

    expect(result.text).toBe(expected);
  });

  // -- Check suite failed --
  test("github.check_suite.failed produces expected output", () => {
    const result = resolveTemplate("github.check_suite.failed", {
      conclusion_emoji: "\u274c",
      pr_number: 42,
      conclusion_label: "FAILED",
      repo_full_name: "owner/repo",
      branch: "feature",
      head_sha_short: "abc1234",
      related_task_id: "task-123",
    });

    expect(result.skipped).toBe(false);

    const expected = `\u274c [GitHub PR #42 CI Suite] FAILED

Repo: owner/repo
Branch: feature
Commit: abc1234

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 CI suite failed. Check individual check runs for details.`;

    expect(result.text).toBe(expected);
  });

  // -- Workflow run failed --
  test("github.workflow_run.failed produces expected output", () => {
    const result = resolveTemplate("github.workflow_run.failed", {
      conclusion_emoji: "\u274c",
      pr_number: 42,
      workflow_run_name: "CI",
      conclusion_label: "FAILED",
      repo_full_name: "owner/repo",
      workflow_name: "CI",
      run_number: 5,
      head_branch: "feature",
      trigger_event: "pull_request",
      logs_url: "https://github.com/owner/repo/actions/runs/123",
      related_task_id: "task-123",
    });

    expect(result.skipped).toBe(false);

    const expected = `\u274c [GitHub PR #42 Workflow] CI FAILED

Repo: owner/repo
Workflow: CI
Run #5
Branch: feature
Triggered by: pull_request
Logs: https://github.com/owner/repo/actions/runs/123

---
Related task: task-123
\ud83d\udd00 Consider routing to the same agent working on the related task.
\ud83d\udca1 Workflow failed. Click the logs URL above to see what went wrong and fix the issue.`;

    expect(result.text).toBe(expected);
  });
});

// ============================================================================
// Skip event behavior
// ============================================================================

describe("skip_event suppresses task creation", () => {
  test("skip_event on a GitHub template returns skipped=true", () => {
    upsertPromptTemplate({
      eventType: "github.pull_request.assigned",
      scope: "global",
      state: "skip_event",
      body: "Skipped body",
    });

    const result = resolveTemplate("github.pull_request.assigned", {
      pr_number: 42,
      pr_title: "Fix bug",
      bot_name: "agent-swarm-bot",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      head_ref: "feature",
      base_ref: "main",
      pr_url: "https://github.com/owner/repo/pull/42",
      context: "body",
    });

    expect(result.skipped).toBe(true);
    expect(result.text).toBe("");
  });
});

// ============================================================================
// Custom override behavior
// ============================================================================

describe("custom body override replaces default", () => {
  test("custom body is used instead of default template", () => {
    // Upsert a custom body for the issue mentioned template
    upsertPromptTemplate({
      eventType: "github.issue.mentioned",
      scope: "global",
      state: "enabled",
      body: "Custom body for issue #{{issue_number}}: {{issue_title}}",
    });

    const result = resolveTemplate("github.issue.mentioned", {
      issue_number: 99,
      issue_title: "Custom test",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      issue_url: "https://github.com/owner/repo/issues/99",
      context: "Some context",
    });

    expect(result.skipped).toBe(false);
    // Header is still code-defined, only body is overridden
    expect(result.text).toBe(
      "[GitHub Issue #99] Custom test\n\nCustom body for issue #99: Custom test",
    );
    expect(result.templateId).toBeDefined();
    expect(result.scope).toBe("global");
  });
});

// ============================================================================
// Common template override
// ============================================================================

describe("common template override affects all referencing templates", () => {
  test("overriding common.delegation_instruction changes output of dependent templates", () => {
    // Override the delegation instruction
    upsertPromptTemplate({
      eventType: "common.delegation_instruction",
      scope: "global",
      state: "enabled",
      body: "Custom delegation: please assign to a worker.",
    });

    const result = resolveTemplate("github.pull_request.mentioned", {
      pr_number: 1,
      pr_title: "Test",
      sender_login: "alice",
      repo_full_name: "owner/repo",
      head_ref: "feat",
      base_ref: "main",
      pr_url: "https://github.com/owner/repo/pull/1",
      context: "test context",
    });

    expect(result.skipped).toBe(false);
    // The delegation instruction in the output should use the custom body
    expect(result.text).toContain("Custom delegation: please assign to a worker.");
    expect(result.text).not.toContain("DELEGATE this task");
  });
});
