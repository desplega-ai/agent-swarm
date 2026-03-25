import { describe, expect, test } from "bun:test";
import {
  buildAssignmentSummaryBlocks,
  buildBufferFlushBlocks,
  buildCancelledBlocks,
  buildCompletedBlocks,
  buildFailedBlocks,
  buildProgressBlocks,
  getTaskLink,
  getTaskUrl,
  markdownToSlack,
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
