import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  clearTemplateDefinitions,
  getAllTemplateDefinitions,
  getTemplateDefinition,
} from "../prompts/registry";
import { resolveTemplate } from "../prompts/resolver";

// Side-effect imports: register all templates from each source
import "../gitlab/templates";
import "../agentmail/templates";
import "../linear/templates";
import "../heartbeat/templates";
import "../tools/templates";
import "../commands/templates";
import "../slack/templates";
import "../prompts/session-templates";

const TEST_DB_PATH = "./test-prompt-remaining.sqlite";

/**
 * Re-register all templates by dynamically re-evaluating template modules.
 * Needed because other test files may call clearTemplateDefinitions() in parallel.
 */
async function ensureTemplatesRegistered(): Promise<void> {
  // Check if templates are still registered (another test may have cleared them)
  if (getTemplateDefinition("gitlab.merge_request.opened")) return;

  // Force re-evaluation by importing with cache-busting query param
  const ts = Date.now();
  await import(`../gitlab/templates?t=${ts}`);
  await import(`../agentmail/templates?t=${ts}`);
  await import(`../linear/templates?t=${ts}`);
  await import(`../heartbeat/templates?t=${ts}`);
  await import(`../tools/templates?t=${ts}`);
  await import(`../commands/templates?t=${ts}`);
  await import(`../slack/templates?t=${ts}`);
  await import(`../prompts/session-templates?t=${ts}`);
}

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

describe("template registration — all sources", () => {
  test("GitLab templates are registered (3 common + 4 event)", () => {
    const all = getAllTemplateDefinitions();
    const eventTypes = all.map((d) => d.eventType);
    expect(eventTypes).toContain("common.delegation_instruction.gitlab");
    expect(eventTypes).toContain("common.command_suggestions.gitlab_mr");
    expect(eventTypes).toContain("common.command_suggestions.gitlab_issue");
    expect(eventTypes).toContain("gitlab.merge_request.opened");
    expect(eventTypes).toContain("gitlab.issue.assigned");
    expect(eventTypes).toContain("gitlab.comment.mentioned");
    expect(eventTypes).toContain("gitlab.pipeline.failed");
  });

  test("AgentMail templates are registered (5 event)", () => {
    const all = getAllTemplateDefinitions();
    const eventTypes = all.map((d) => d.eventType);
    expect(eventTypes).toContain("agentmail.email.followup");
    expect(eventTypes).toContain("agentmail.email.mapped_lead");
    expect(eventTypes).toContain("agentmail.email.mapped_worker");
    expect(eventTypes).toContain("agentmail.email.unmapped");
    expect(eventTypes).toContain("agentmail.email.no_agent");
  });

  test("Linear templates are registered (2 event)", () => {
    const all = getAllTemplateDefinitions();
    const eventTypes = all.map((d) => d.eventType);
    expect(eventTypes).toContain("linear.issue.assigned");
    expect(eventTypes).toContain("linear.issue.followup");
  });

  test("Heartbeat template is registered (1 event)", () => {
    const all = getAllTemplateDefinitions();
    const eventTypes = all.map((d) => d.eventType);
    expect(eventTypes).toContain("heartbeat.escalation.stalled");
  });

  test("Task lifecycle templates are registered (2 task_lifecycle)", () => {
    const all = getAllTemplateDefinitions();
    const eventTypes = all.map((d) => d.eventType);
    expect(eventTypes).toContain("task.worker.completed");
    expect(eventTypes).toContain("task.worker.failed");
  });

  test("Runner trigger templates are registered (8 task_lifecycle)", () => {
    const all = getAllTemplateDefinitions();
    const eventTypes = all.map((d) => d.eventType);
    expect(eventTypes).toContain("task.trigger.assigned");
    expect(eventTypes).toContain("task.trigger.offered");
    expect(eventTypes).toContain("task.trigger.unread_mentions");
    expect(eventTypes).toContain("task.trigger.pool_available");
    expect(eventTypes).toContain("task.trigger.epic_progress");
    expect(eventTypes).toContain("task.trigger.channel_activity");
    expect(eventTypes).toContain("task.resumption.with_progress");
    expect(eventTypes).toContain("task.resumption.no_progress");
  });

  test("Slack templates are registered (4 system)", () => {
    const all = getAllTemplateDefinitions();
    const eventTypes = all.map((d) => d.eventType);
    expect(eventTypes).toContain("slack.assistant.greeting");
    expect(eventTypes).toContain("slack.assistant.suggested_prompts");
    expect(eventTypes).toContain("slack.assistant.offline");
    expect(eventTypes).toContain("slack.message.thread_context");
  });
});

// ============================================================================
// Backward compatibility — byte-identical output
// ============================================================================

describe("GitLab — backward compatibility", () => {
  test("gitlab.merge_request.opened produces expected output", () => {
    const result = resolveTemplate("gitlab.merge_request.opened", {
      mr_iid: 5,
      mr_title: "Add feature",
      repo: "group/project",
      username: "dev1",
      source_branch: "feature-branch",
      target_branch: "main",
      mr_url: "https://gitlab.com/group/project/-/merge_requests/5",
      context_section: "Context: Please review this MR\n\n",
    });

    expect(result.skipped).toBe(false);
    expect(result.unresolved.length).toBe(0);

    const expected = `[GitLab MR #5] Add feature

Repo: group/project
Author: @dev1
Branch: feature-branch \u2192 main
URL: https://gitlab.com/group/project/-/merge_requests/5

Context: Please review this MR

Suggested commands: \`/review-pr\` to review the MR, \`/implement-issue\` to implement changes.

**Delegation instruction:** As the lead agent, analyze this and decide whether to handle it yourself or delegate to a worker agent. Use \`send-task\` to delegate with clear instructions.`;

    expect(result.text).toBe(expected);
  });

  test("gitlab.pipeline.failed produces expected output", () => {
    const result = resolveTemplate("gitlab.pipeline.failed", {
      pipeline_id: 999,
      mr_iid: 5,
      repo: "group/project",
      mr_title: "Add feature",
      mr_url: "https://gitlab.com/group/project/-/merge_requests/5",
      source_branch: "feature-branch",
    });

    expect(result.skipped).toBe(false);

    const expected = `[GitLab CI Failed] Pipeline #999 failed for MR #5

Repo: group/project
MR: Add feature
URL: https://gitlab.com/group/project/-/merge_requests/5
Branch: feature-branch

The CI pipeline has failed. Please investigate and fix the issues.

**Delegation instruction:** As the lead agent, analyze this and decide whether to handle it yourself or delegate to a worker agent. Use \`send-task\` to delegate with clear instructions.`;

    expect(result.text).toBe(expected);
  });

  test("gitlab.comment.mentioned produces expected output", () => {
    const result = resolveTemplate("gitlab.comment.mentioned", {
      entity_label: "MR #5",
      username: "dev1",
      repo: "group/project",
      target_url: "https://gitlab.com/group/project/-/merge_requests/5",
      context: "Can you look at this?",
      existing_task_note: "\n\n_Note: There's an active task (task-abc) for this MR #5._",
    });

    expect(result.skipped).toBe(false);

    const expected = `[GitLab Comment on MR #5] @dev1 mentioned bot

Repo: group/project
URL: https://gitlab.com/group/project/-/merge_requests/5

Comment:
Can you look at this?

_Note: There's an active task (task-abc) for this MR #5._

**Delegation instruction:** As the lead agent, analyze this and decide whether to handle it yourself or delegate to a worker agent. Use \`send-task\` to delegate with clear instructions.`;

    expect(result.text).toBe(expected);
  });
});

describe("AgentMail — backward compatibility", () => {
  test("agentmail.email.followup produces expected output", () => {
    const result = resolveTemplate("agentmail.email.followup", {
      from: "user@example.com",
      subject: "Re: Hello",
      inbox_id: "inbox@mail.example.com",
      thread_id: "thread-123",
      preview: "Thanks for the reply!",
    });

    expect(result.skipped).toBe(false);

    const expected = `[AgentMail] Follow-up email in thread

From: user@example.com
Subject: Re: Hello
Inbox: inbox@mail.example.com
Thread: thread-123

Thanks for the reply!`;

    expect(result.text).toBe(expected);
  });

  test("agentmail.email.unmapped produces expected output", () => {
    const result = resolveTemplate("agentmail.email.unmapped", {
      from: "user@example.com",
      subject: "New request",
      inbox_id: "inbox@mail.example.com",
      thread_id: "thread-456",
      message_id: "msg-789",
      preview: "Please help with this.",
    });

    expect(result.skipped).toBe(false);

    const expected = `[AgentMail] New email received (unmapped inbox)

From: user@example.com
Subject: New request
Inbox: inbox@mail.example.com
Thread: thread-456
Message: msg-789

Please help with this.`;

    expect(result.text).toBe(expected);
  });
});

describe("Linear — backward compatibility", () => {
  test("linear.issue.assigned produces expected output", () => {
    const result = resolveTemplate("linear.issue.assigned", {
      issue_identifier: "ENG-123",
      issue_title: "Fix login bug",
      issue_url: "https://linear.app/team/issue/ENG-123",
      session_section: "\nSession: https://linear.app/session/abc",
      description_section: "\nDescription:\nUsers cannot login with SSO\n",
    });

    expect(result.skipped).toBe(false);

    const expected = `[Linear ENG-123] Fix login bug

Source: Linear (Agent Session)
URL: https://linear.app/team/issue/ENG-123
Session: https://linear.app/session/abc

Description:
Users cannot login with SSO
`;

    expect(result.text).toBe(expected);
  });

  test("linear.issue.followup produces expected output", () => {
    const result = resolveTemplate("linear.issue.followup", {
      issue_identifier: "ENG-123",
      issue_title: "Fix login bug",
      issue_url: "https://linear.app/team/issue/ENG-123",
      user_message: "Can you also check the OAuth flow?",
    });

    expect(result.skipped).toBe(false);

    const expected = `[Linear ENG-123] Follow-up: Fix login bug

Source: Linear (Agent Session follow-up)
URL: https://linear.app/team/issue/ENG-123

User message:
Can you also check the OAuth flow?

Original issue: ENG-123 \u2014 Fix login bug`;

    expect(result.text).toBe(expected);
  });
});

describe("Task lifecycle — backward compatibility", () => {
  test("task.worker.completed produces expected output", () => {
    const result = resolveTemplate("task.worker.completed", {
      agent_name: "Worker-1",
      task_desc: "Fix the login page CSS",
      output_summary: "Fixed the CSS alignment issue on the login form",
      task_id: "task-abc-123",
    });

    expect(result.skipped).toBe(false);

    const expected = `Worker task completed \u2014 review needed.

Agent: Worker-1
Task: "Fix the login page CSS"

Output:
Fixed the CSS alignment issue on the login form

Use \`get-task-details\` with taskId "task-abc-123" for full details.`;

    expect(result.text).toBe(expected);
  });

  test("task.worker.failed produces expected output", () => {
    const result = resolveTemplate("task.worker.failed", {
      agent_name: "Worker-2",
      task_desc: "Deploy to production",
      failure_reason: "Docker build failed: missing dependency",
      task_id: "task-def-456",
    });

    expect(result.skipped).toBe(false);

    const expected = `Worker task failed \u2014 action needed.

Agent: Worker-2
Task: "Deploy to production"

Failure reason: Docker build failed: missing dependency

Decide whether to reassign, retry, or handle the failure. Use \`get-task-details\` with taskId "task-def-456" for full details.`;

    expect(result.text).toBe(expected);
  });
});

describe("Runner triggers — backward compatibility", () => {
  test("task.trigger.assigned produces expected output", () => {
    const result = resolveTemplate("task.trigger.assigned", {
      work_on_task_cmd: "/work-on-task",
      task_id: "abc123",
      task_desc_section: '\n\nTask: "Fix the bug"',
      output_instructions:
        '\n\nWhen done, use `store-progress` with status: "completed" and include your output.',
    });

    expect(result.skipped).toBe(false);

    const expected = `/work-on-task abc123

Task: "Fix the bug"

When done, use \`store-progress\` with status: "completed" and include your output.`;

    expect(result.text).toBe(expected);
  });

  test("task.trigger.unread_mentions produces expected output", () => {
    const result = resolveTemplate("task.trigger.unread_mentions", {
      mention_count: 3,
    });

    expect(result.skipped).toBe(false);

    const expected = `You have 3 mention(s) in chat channels.

1. Use \`read-messages\` with unreadOnly: true to see them
2. Respond to questions or requests directed at you
3. If a message requires work, create a task using \`send-task\``;

    expect(result.text).toBe(expected);
  });

  test("task.trigger.pool_available produces expected output", () => {
    const result = resolveTemplate("task.trigger.pool_available", {
      task_count: 5,
    });

    expect(result.skipped).toBe(false);

    const expected = `5 task(s) available in the pool.

1. Run \`get-tasks\` with unassigned: true to browse
2. Pick one matching your skills
3. Run \`task-action\` with action: "claim" and taskId: "<id>"

Note: Claims are first-come-first-serve. If claim fails, pick another.`;

    expect(result.text).toBe(expected);
  });

  test("task.resumption.with_progress produces expected output", () => {
    const result = resolveTemplate("task.resumption.with_progress", {
      work_on_task_cmd: "/work-on-task",
      task_id: "task-xyz",
      task_description: "Fix the test suite",
      progress: "Fixed 3 of 5 failing tests",
    });

    expect(result.skipped).toBe(false);

    const expected = `/work-on-task task-xyz

**RESUMED TASK** - This task was interrupted during a deployment and is being resumed.

Task: "Fix the test suite"

Previous Progress:
Fixed 3 of 5 failing tests

Continue from where you left off. Review the progress above and complete the remaining work.

When done, use \`store-progress\` with status: "completed" and include your output.`;

    expect(result.text).toBe(expected);
  });

  test("task.resumption.no_progress produces expected output", () => {
    const result = resolveTemplate("task.resumption.no_progress", {
      work_on_task_cmd: "/work-on-task",
      task_id: "task-xyz",
      task_description: "Fix the test suite",
    });

    expect(result.skipped).toBe(false);

    const expected = `/work-on-task task-xyz

**RESUMED TASK** - This task was interrupted during a deployment and is being resumed.

Task: "Fix the test suite"

No progress was saved before the interruption. Start the task fresh but be aware files may have been partially modified.

When done, use \`store-progress\` with status: "completed" and include your output.`;

    expect(result.text).toBe(expected);
  });
});

describe("Slack — backward compatibility", () => {
  test("slack.assistant.greeting produces expected output", () => {
    const result = resolveTemplate("slack.assistant.greeting", {});
    expect(result.skipped).toBe(false);
    expect(result.text).toBe("Hi! I'm your Agent Swarm assistant. How can I help?");
  });

  test("slack.assistant.offline produces expected output", () => {
    const result = resolveTemplate("slack.assistant.offline", {});
    expect(result.skipped).toBe(false);
    expect(result.text).toBe(
      "No agents are available right now. Your request has been queued and will be processed when agents come back online.",
    );
  });

  test("slack.message.thread_context produces expected output", () => {
    const result = resolveTemplate("slack.message.thread_context", {
      thread_messages: "Alice: Hello\n[Agent]: Hi there!",
    });

    expect(result.skipped).toBe(false);

    const expected = `<thread_context>
Alice: Hello
[Agent]: Hi there!
</thread_context>`;

    expect(result.text).toBe(expected);
  });
});
