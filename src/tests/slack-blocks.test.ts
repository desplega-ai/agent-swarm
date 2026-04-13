import { describe, expect, test } from "bun:test";
import {
  buildAssignmentSummaryBlocks,
  buildBufferFlushBlocks,
  buildCancelledBlocks,
  buildCompletedBlocks,
  buildFailedBlocks,
  buildProgressBlocks,
  buildTreeBlocks,
  formatDuration,
  getTaskLink,
  getTaskUrl,
  markdownToSlack,
  type TreeNode,
} from "../slack/blocks";

describe("markdownToSlack", () => {
  test("converts bold correctly without italic interference", () => {
    // **hello** → *hello* (Slack bold)
    expect(markdownToSlack("**hello**")).toBe("*hello*");
    expect(markdownToSlack("**hello world**")).toBe("*hello world*");
  });

  test("converts italic", () => {
    expect(markdownToSlack("*hello*")).toBe("_hello_");
  });

  test("converts strikethrough", () => {
    expect(markdownToSlack("~~hello~~")).toBe("~hello~");
  });

  test("converts links", () => {
    expect(markdownToSlack("[click](https://example.com)")).toBe("<https://example.com|click>");
  });

  test("converts headers to bold", () => {
    // ## Header → *Header* (Slack bold)
    expect(markdownToSlack("## Header")).toBe("*Header*");
  });

  test("collapses excessive blank lines", () => {
    expect(markdownToSlack("a\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("getTaskLink", () => {
  test("returns short ID when no APP_URL", () => {
    // APP_URL is not set in test env
    const link = getTaskLink("abcdef12-3456-7890-abcd-ef1234567890");
    expect(link).toContain("abcdef12");
  });
});

describe("getTaskUrl", () => {
  test("returns URL with task ID or empty string", () => {
    const url = getTaskUrl("some-id");
    // When APP_URL is set, URL contains the task ID; when not set, returns ""
    if (url) {
      expect(url).toContain("some-id");
    } else {
      expect(url).toBe("");
    }
  });
});

describe("buildCompletedBlocks", () => {
  test("returns single-line header + body section", () => {
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: "Task output here",
    });

    expect(blocks.length).toBe(2);
    // First block: single-line with emoji, agent name, task link
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("✅");
    expect(blocks[0].text.text).toContain("Alpha");
    expect(blocks[0].text.text).toContain("abcdef12");
    // Second block: body content
    expect(blocks[1].type).toBe("section");
    expect(blocks[1].text.text).toBe("Task output here");
  });

  test("includes duration when provided", () => {
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: "Done",
      duration: "45s",
    });

    expect(blocks[0].text.text).toContain("45s");
  });

  test("splits long body into multiple sections", () => {
    const longBody = "x".repeat(6000);
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: longBody,
    });

    // 1 header line + N body sections
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const bodySections = blocks.slice(1);
    expect(bodySections.length).toBeGreaterThanOrEqual(2);
    const totalText = bodySections.map((s) => s.text.text).join("");
    expect(totalText).toBe(longBody);
  });
});

describe("buildFailedBlocks", () => {
  test("returns single-line header + error section", () => {
    const blocks = buildFailedBlocks({
      agentName: "Beta",
      taskId: "12345678-abcd-ef12-3456-7890abcdef12",
      reason: "Something broke",
    });

    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("❌");
    expect(blocks[0].text.text).toContain("Beta");
    expect(blocks[0].text.text).toContain("12345678");
    expect(blocks[1].type).toBe("section");
    expect(blocks[1].text.text).toContain("Something broke");
  });

  test("includes duration when provided", () => {
    const blocks = buildFailedBlocks({
      agentName: "Beta",
      taskId: "12345678-abcd-ef12-3456-7890abcdef12",
      reason: "Error",
      duration: "2m 30s",
    });

    expect(blocks[0].text.text).toContain("2m 30s");
  });
});

describe("buildProgressBlocks", () => {
  test("returns single-line section + cancel action", () => {
    const blocks = buildProgressBlocks({
      agentName: "Gamma",
      taskId: "aabbccdd-1234-5678-9012-abcdefabcdef",
      progress: "Analyzing codebase...",
    });

    expect(blocks.length).toBe(2);
    // Single line: *Gamma* (`aabbccdd`): Analyzing codebase...
    // (no ⏳ prefix — progress strings now carry their own emoji)
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).not.toContain("⏳");
    expect(blocks[0].text.text).toContain("Gamma");
    expect(blocks[0].text.text).toContain("aabbccdd");
    expect(blocks[0].text.text).toContain("Analyzing codebase...");
    // Cancel button
    expect(blocks[1].type).toBe("actions");
    expect(blocks[1].elements[0].action_id).toBe("cancel_task");
    expect(blocks[1].elements[0].style).toBe("danger");
    expect(blocks[1].elements[0].confirm).toBeDefined();
  });
});

describe("buildAssignmentSummaryBlocks", () => {
  test("single assigned task — one-line format", () => {
    const blocks = buildAssignmentSummaryBlocks({
      assigned: [{ agentName: "Alpha", taskId: "aabb1122-0000-0000-0000-000000000000" }],
      queued: [],
      failed: [],
    });

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("📡 Task assigned to:");
    expect(blocks[0].text.text).toContain("Alpha");
    expect(blocks[0].text.text).toContain("aabb1122");
  });

  test("mixed assigned, queued, and failed", () => {
    const blocks = buildAssignmentSummaryBlocks({
      assigned: [{ agentName: "Alpha", taskId: "aaaa0000-0000-0000-0000-000000000000" }],
      queued: [{ agentName: "Beta", taskId: "bbbb0000-0000-0000-0000-000000000000" }],
      failed: [{ agentName: "Gamma", reason: "offline" }],
    });

    expect(blocks.length).toBe(1);
    const text = blocks[0].text.text;
    expect(text).toContain("Task assigned to:");
    expect(text).toContain("Alpha");
    expect(text).toContain("Task queued for:");
    expect(text).toContain("Beta");
    expect(text).toContain("Could not assign to:");
    expect(text).toContain("Gamma");
    expect(text).toContain("offline");
  });

  test("all failed shows warning", () => {
    const blocks = buildAssignmentSummaryBlocks({
      assigned: [],
      queued: [],
      failed: [{ agentName: "Delta", reason: "error" }],
    });

    expect(blocks[0].text.text).toContain("⚠️");
    expect(blocks[0].text.text).toContain("Could not assign");
  });
});

describe("buildCancelledBlocks", () => {
  test("returns single section block", () => {
    const blocks = buildCancelledBlocks({
      agentName: "Alpha",
      taskId: "cccc0000-0000-0000-0000-000000000000",
    });

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("🚫");
    expect(blocks[0].text.text).toContain("Alpha");
    expect(blocks[0].text.text).toContain("Cancelled");
    expect(blocks[0].text.text).toContain("cccc0000");
  });
});

describe("buildBufferFlushBlocks", () => {
  test("without dependency", () => {
    const blocks = buildBufferFlushBlocks({
      messageCount: 3,
      taskId: "dddd0000-0000-0000-0000-000000000000",
      hasDependency: false,
    });

    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("context");
    expect(blocks[0].elements[0].text).toContain("3 follow-up");
    expect(blocks[0].elements[0].text).toContain("batched into task");
  });

  test("with dependency", () => {
    const blocks = buildBufferFlushBlocks({
      messageCount: 2,
      taskId: "eeee0000-0000-0000-0000-000000000000",
      hasDependency: true,
    });

    expect(blocks[0].elements[0].text).toContain("queued pending");
  });
});

describe("buildCompletedBlocks — minimal mode", () => {
  test("minimal: true suppresses body sections", () => {
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: "This body should be suppressed",
      minimal: true,
    });

    // Only the header block, no body sections
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("✅");
    expect(blocks[0].text.text).toContain("Alpha");
    expect(blocks[0].text.text).not.toContain("This body should be suppressed");
  });

  test("minimal: false includes body sections (default behavior)", () => {
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: "Task output here",
      minimal: false,
    });

    expect(blocks.length).toBe(2);
    expect(blocks[1].text.text).toBe("Task output here");
  });

  test("minimal: true with duration shows duration in header", () => {
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: "Suppressed",
      duration: "2m 14s",
      minimal: true,
    });

    expect(blocks.length).toBe(1);
    expect(blocks[0].text.text).toContain("2m 14s");
  });

  test("duration shown in header without minimal mode", () => {
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: "Output",
      duration: "1h 5m",
    });

    expect(blocks[0].text.text).toContain("1h 5m");
    // Body still present
    expect(blocks.length).toBe(2);
    expect(blocks[1].text.text).toBe("Output");
  });
});

describe("formatDuration", () => {
  test("seconds only (< 60s)", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T00:00:45Z");
    expect(formatDuration(start, end)).toBe("45s");
  });

  test("zero seconds", () => {
    const t = new Date("2026-01-01T00:00:00Z");
    expect(formatDuration(t, t)).toBe("0s");
  });

  test("minutes and seconds (< 60m)", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T00:02:14Z");
    expect(formatDuration(start, end)).toBe("2m 14s");
  });

  test("exact minutes (no remaining seconds)", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T00:05:00Z");
    expect(formatDuration(start, end)).toBe("5m 0s");
  });

  test("hours and minutes (>= 60m)", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T01:30:00Z");
    expect(formatDuration(start, end)).toBe("1h 30m");
  });

  test("multiple hours", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T03:15:00Z");
    expect(formatDuration(start, end)).toBe("3h 15m");
  });

  test("just under a minute", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T00:00:59Z");
    expect(formatDuration(start, end)).toBe("59s");
  });

  test("exactly one minute", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T00:01:00Z");
    expect(formatDuration(start, end)).toBe("1m 0s");
  });

  test("exactly one hour", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T01:00:00Z");
    expect(formatDuration(start, end)).toBe("1h 0m");
  });
});

// --- buildTreeBlocks tests ---

function makeTaskId(prefix: string): string {
  return `${prefix}-0000-0000-0000-000000000000`;
}

describe("buildTreeBlocks", () => {
  test("single root, no children", () => {
    const root: TreeNode = {
      taskId: makeTaskId("aaaa0001"),
      agentName: "Lead",
      status: "in_progress",
      children: [],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(blocks[0].type).toBe("section");
    expect(text).toContain("⏳");
    expect(text).toContain("*Lead*");
    expect(text).toContain("aaaa0001");
    // Should have a cancel button since it's in_progress
    expect(blocks.length).toBe(2);
    expect(blocks[1].type).toBe("actions");
    expect(blocks[1].elements[0].action_id).toBe("cancel_task");
    expect(blocks[1].elements[0].value).toBe(makeTaskId("aaaa0001"));
  });

  test("single root with progress, no children", () => {
    const root: TreeNode = {
      taskId: makeTaskId("aaaa0002"),
      agentName: "Lead",
      status: "in_progress",
      progress: "Analyzing requirements...",
      children: [],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("⏳");
    expect(text).toContain("*Lead*");
    expect(text).toContain("Analyzing requirements...");
  });

  test("root + 2 completed children (one with slackReplySent, one without)", () => {
    const root: TreeNode = {
      taskId: makeTaskId("bbbb0001"),
      agentName: "Lead",
      status: "completed",
      duration: "3m 20s",
      children: [
        {
          taskId: makeTaskId("bbbb0002"),
          agentName: "Worker1",
          status: "completed",
          duration: "2m 14s",
          slackReplySent: true,
          output: "This should NOT appear",
          children: [],
        },
        {
          taskId: makeTaskId("bbbb0003"),
          agentName: "Worker2",
          status: "completed",
          duration: "1m 30s",
          slackReplySent: false,
          output: "Here is the analysis result",
          children: [],
        },
      ],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    // Root line
    expect(text).toContain("✅");
    expect(text).toContain("*Lead*");
    expect(text).toContain("3m 20s");

    // Worker1 — slackReplySent, so no output
    expect(text).toContain("*Worker1*");
    expect(text).toContain("2m 14s");
    expect(text).not.toContain("This should NOT appear");

    // Worker2 — no slackReplySent, output shown
    expect(text).toContain("*Worker2*");
    expect(text).toContain("1m 30s");
    expect(text).toContain("Here is the analysis result");

    // No cancel button (all completed)
    expect(blocks.length).toBe(1);
  });

  test("mixed states: completed, failed, cancelled, in_progress", () => {
    const root: TreeNode = {
      taskId: makeTaskId("cccc0001"),
      agentName: "Lead",
      status: "in_progress",
      children: [
        {
          taskId: makeTaskId("cccc0002"),
          agentName: "Worker1",
          status: "completed",
          duration: "2m 14s",
          slackReplySent: true,
          children: [],
        },
        {
          taskId: makeTaskId("cccc0003"),
          agentName: "Worker2",
          status: "failed",
          duration: "45s",
          failureReason: "API rate limit exceeded",
          children: [],
        },
        {
          taskId: makeTaskId("cccc0004"),
          agentName: "Worker3",
          status: "cancelled",
          children: [],
        },
        {
          taskId: makeTaskId("cccc0005"),
          agentName: "Worker4",
          status: "in_progress",
          progress: "Setting up Cloud Function...",
          children: [],
        },
      ],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    // Root
    expect(text).toContain("⏳ *Lead*");

    // Worker1 — completed
    expect(text).toContain("✅ *Worker1*");

    // Worker2 — failed with error
    expect(text).toContain("❌ *Worker2*");
    expect(text).toContain("Error: API rate limit exceeded");

    // Worker3 — cancelled
    expect(text).toContain("🚫 *Worker3*");

    // Worker4 — in_progress with progress
    expect(text).toContain("⏳ *Worker4*");
    expect(text).toContain("Setting up Cloud Function...");

    // Cancel button (root is in_progress)
    expect(blocks.length).toBe(2);
    expect(blocks[1].type).toBe("actions");
  });

  test("progress text rendering with tree connectors", () => {
    const root: TreeNode = {
      taskId: makeTaskId("dddd0001"),
      agentName: "Lead",
      status: "in_progress",
      children: [
        {
          taskId: makeTaskId("dddd0002"),
          agentName: "Worker1",
          status: "in_progress",
          progress: "Fetching data...",
          children: [],
        },
        {
          taskId: makeTaskId("dddd0003"),
          agentName: "Worker2",
          status: "in_progress",
          progress: "Compiling...",
          children: [],
        },
      ],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;
    const lines = text.split("\n");

    // Root line
    expect(lines[0]).toContain("⏳ *Lead*");
    // Worker1 line with ├ prefix
    expect(lines[1]).toMatch(/^├ ⏳ \*Worker1\*/);
    // Worker1 progress indented under continuation
    expect(lines[2]).toMatch(/^│ {3}Fetching data\.\.\.$/);
    // Worker2 line with └ prefix (last child)
    expect(lines[3]).toMatch(/^└ ⏳ \*Worker2\*/);
    // Worker2 progress indented
    expect(lines[4]).toMatch(/^ {4}Compiling\.\.\.$/);
  });

  test("max children collapse (9+ children -> 8 shown + 'and 1 more...')", () => {
    const children: TreeNode[] = [];
    for (let i = 1; i <= 9; i++) {
      children.push({
        taskId: makeTaskId(`eeee000${i}`),
        agentName: `Worker${i}`,
        status: "in_progress",
        children: [],
      });
    }

    const root: TreeNode = {
      taskId: makeTaskId("eeee0000"),
      agentName: "Lead",
      status: "in_progress",
      children,
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;
    const lines = text.split("\n");

    // Root + 8 visible children + "and 1 more..." = 10 lines
    expect(lines.length).toBe(10);
    expect(text).toContain("*Worker1*");
    expect(text).toContain("*Worker8*");
    expect(text).not.toContain("*Worker9*");
    expect(text).toContain("and 1 more...");
    // The "and N more..." line uses └ prefix
    expect(lines[lines.length - 1]).toContain("└ _and 1 more..._");
  });

  test("max children collapse with many hidden", () => {
    const children: TreeNode[] = [];
    for (let i = 1; i <= 12; i++) {
      children.push({
        taskId: makeTaskId(`ff00000${String(i).padStart(1, "0")}`),
        agentName: `Worker${i}`,
        status: "pending",
        children: [],
      });
    }

    const root: TreeNode = {
      taskId: makeTaskId("ff000000"),
      agentName: "Lead",
      status: "in_progress",
      children,
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("and 4 more...");
  });

  test("error text always shown for failed nodes", () => {
    const root: TreeNode = {
      taskId: makeTaskId("gggg0001"),
      agentName: "Lead",
      status: "failed",
      failureReason: "Connection timeout",
      children: [],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("❌ *Lead*");
    expect(text).toContain("Error: Connection timeout");
    // No cancel button (failed is terminal)
    expect(blocks.length).toBe(1);
  });

  test("failed child always shows error text regardless of slackReplySent", () => {
    const root: TreeNode = {
      taskId: makeTaskId("hhhh0001"),
      agentName: "Lead",
      status: "completed",
      children: [
        {
          taskId: makeTaskId("hhhh0002"),
          agentName: "Worker1",
          status: "failed",
          failureReason: "Out of memory",
          slackReplySent: true,
          children: [],
        },
      ],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("Error: Out of memory");
  });

  test("all task IDs are links (contain short ID)", () => {
    const root: TreeNode = {
      taskId: makeTaskId("iiii0001"),
      agentName: "Lead",
      status: "in_progress",
      children: [
        {
          taskId: makeTaskId("iiii0002"),
          agentName: "Worker1",
          status: "completed",
          children: [],
        },
      ],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("iiii0001");
    expect(text).toContain("iiii0002");
  });

  test("multiple root nodes", () => {
    const roots: TreeNode[] = [
      {
        taskId: makeTaskId("jjjj0001"),
        agentName: "Agent1",
        status: "in_progress",
        children: [],
      },
      {
        taskId: makeTaskId("jjjj0002"),
        agentName: "Agent2",
        status: "completed",
        duration: "1m 5s",
        children: [],
      },
    ];

    const blocks = buildTreeBlocks(roots);
    const text = blocks[0].text.text;

    // Both roots in same section block
    expect(text).toContain("⏳ *Agent1*");
    expect(text).toContain("✅ *Agent2*");
    expect(text).toContain("1m 5s");

    // Cancel button for Agent1 (in_progress) but not Agent2
    // blocks[0] = section, blocks[1] = cancel for Agent1
    expect(blocks.length).toBe(2);
    expect(blocks[1].type).toBe("actions");
    expect(blocks[1].elements[0].value).toBe(makeTaskId("jjjj0001"));
  });

  test("multiple roots — separate cancel buttons per active root", () => {
    const roots: TreeNode[] = [
      {
        taskId: makeTaskId("kkkk0001"),
        agentName: "Agent1",
        status: "in_progress",
        children: [],
      },
      {
        taskId: makeTaskId("kkkk0002"),
        agentName: "Agent2",
        status: "in_progress",
        children: [],
      },
    ];

    const blocks = buildTreeBlocks(roots);

    // section + 2 cancel buttons
    expect(blocks.length).toBe(3);
    expect(blocks[1].type).toBe("actions");
    expect(blocks[1].elements[0].value).toBe(makeTaskId("kkkk0001"));
    expect(blocks[2].type).toBe("actions");
    expect(blocks[2].elements[0].value).toBe(makeTaskId("kkkk0002"));
  });

  test("pending root shows queued icon", () => {
    const root: TreeNode = {
      taskId: makeTaskId("llll0001"),
      agentName: "QueuedAgent",
      status: "pending",
      children: [],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("📡");
    expect(text).toContain("*QueuedAgent*");
    // Pending is active, so cancel button shown
    expect(blocks.length).toBe(2);
  });

  test("cancelled root shows cancel icon with no cancel button", () => {
    const root: TreeNode = {
      taskId: makeTaskId("mmmm0001"),
      agentName: "CancelledAgent",
      status: "cancelled",
      children: [],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("🚫");
    expect(text).toContain("*CancelledAgent*");
    // No cancel button (already cancelled)
    expect(blocks.length).toBe(1);
  });

  test("tree connectors: ├ for non-last, └ for last child", () => {
    const root: TreeNode = {
      taskId: makeTaskId("nnnn0001"),
      agentName: "Lead",
      status: "in_progress",
      children: [
        {
          taskId: makeTaskId("nnnn0002"),
          agentName: "First",
          status: "completed",
          children: [],
        },
        {
          taskId: makeTaskId("nnnn0003"),
          agentName: "Middle",
          status: "completed",
          children: [],
        },
        {
          taskId: makeTaskId("nnnn0004"),
          agentName: "Last",
          status: "completed",
          children: [],
        },
      ],
    };

    const blocks = buildTreeBlocks([root]);
    const lines = blocks[0].text.text.split("\n");

    // First two children use ├, last uses └
    expect(lines[1]).toMatch(/^├ /);
    expect(lines[2]).toMatch(/^├ /);
    expect(lines[3]).toMatch(/^└ /);
  });

  test("completed root with output (no slackReplySent, no children)", () => {
    const root: TreeNode = {
      taskId: makeTaskId("oooo0001"),
      agentName: "Solo",
      status: "completed",
      duration: "10s",
      slackReplySent: false,
      output: "Result: 42",
      children: [],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("✅ *Solo*");
    expect(text).toContain("10s");
    expect(text).toContain("Result: 42");
  });

  test("completed root with slackReplySent suppresses output", () => {
    const root: TreeNode = {
      taskId: makeTaskId("pppp0001"),
      agentName: "Solo",
      status: "completed",
      slackReplySent: true,
      output: "Should not appear",
      children: [],
    };

    const blocks = buildTreeBlocks([root]);
    const text = blocks[0].text.text;

    expect(text).toContain("✅ *Solo*");
    expect(text).not.toContain("Should not appear");
  });
});
