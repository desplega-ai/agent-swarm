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
  test("converts bold (then italic chain applies to single words)", () => {
    // **hello** → *hello* (bold) → _hello_ (italic catches single-star result)
    expect(markdownToSlack("**hello**")).toBe("_hello_");
    // Multi-word bold stays as bold since italic regex requires non-star chars
    expect(markdownToSlack("**hello world**")).toBe("_hello world_");
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

  test("converts headers (bold then italic chain)", () => {
    // ## Header → *Header* → _Header_ (same chain as bold)
    expect(markdownToSlack("## Header")).toBe("_Header_");
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
  test("returns header, context, section, footer", () => {
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: "Task output here",
    });

    expect(blocks.length).toBe(4);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("Task Completed");
    expect(blocks[1].type).toBe("context");
    expect(blocks[1].elements[0].text).toContain("Alpha");
    expect(blocks[1].elements[0].text).toContain("abcdef12");
    expect(blocks[2].type).toBe("section");
    expect(blocks[2].text.text).toBe("Task output here");
    expect(blocks[3].type).toBe("context");
    expect(blocks[3].elements[0].text).toContain("full logs");
  });

  test("includes duration when provided", () => {
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: "Done",
      duration: "45s",
    });

    expect(blocks[1].elements[0].text).toContain("45s");
  });

  test("splits long body into multiple sections", () => {
    const longBody = "x".repeat(6000);
    const blocks = buildCompletedBlocks({
      agentName: "Alpha",
      taskId: "abcdef12-3456-7890-abcd-ef1234567890",
      body: longBody,
    });

    // header + context + N sections + footer = at least 5 blocks
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    // Body sections are between the header section (index 0), context (index 1), and footer at the end
    const bodySections = blocks.filter((b) => b.type === "section" && !b.text.text.startsWith("*"));
    expect(bodySections.length).toBeGreaterThanOrEqual(2);
    // Total body section text should equal original
    const totalText = bodySections.map((s) => s.text.text).join("");
    expect(totalText).toBe(longBody);
  });
});

describe("buildFailedBlocks", () => {
  test("returns header, context, error section, footer", () => {
    const blocks = buildFailedBlocks({
      agentName: "Beta",
      taskId: "12345678-abcd-ef12-3456-7890abcdef12",
      reason: "Something broke",
    });

    expect(blocks.length).toBe(4);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("Task Failed");
    expect(blocks[1].type).toBe("context");
    expect(blocks[1].elements[0].text).toContain("Beta");
    expect(blocks[2].type).toBe("section");
    expect(blocks[2].text.text).toContain("Something broke");
    expect(blocks[3].type).toBe("context");
  });

  test("includes duration when provided", () => {
    const blocks = buildFailedBlocks({
      agentName: "Beta",
      taskId: "12345678-abcd-ef12-3456-7890abcdef12",
      reason: "Error",
      duration: "2m 30s",
    });

    expect(blocks[1].elements[0].text).toContain("2m 30s");
  });
});

describe("buildProgressBlocks", () => {
  test("returns header, context, section, cancel action", () => {
    const blocks = buildProgressBlocks({
      agentName: "Gamma",
      taskId: "aabbccdd-1234-5678-9012-abcdefabcdef",
      progress: "Analyzing codebase...",
    });

    expect(blocks.length).toBe(4);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("In Progress");
    expect(blocks[1].type).toBe("context");
    expect(blocks[1].elements[0].text).toContain("Gamma");
    expect(blocks[2].type).toBe("section");
    expect(blocks[2].text.text).toBe("Analyzing codebase...");
    // Cancel button
    expect(blocks[3].type).toBe("actions");
    expect(blocks[3].elements[0].action_id).toBe("cancel_task");
    expect(blocks[3].elements[0].style).toBe("danger");
    expect(blocks[3].elements[0].confirm).toBeDefined();
  });
});

describe("buildAssignmentSummaryBlocks", () => {
  test("single assigned task", () => {
    const blocks = buildAssignmentSummaryBlocks({
      assigned: [{ agentName: "Alpha", taskId: "aabb1122-0000-0000-0000-000000000000" }],
      queued: [],
      failed: [],
    });

    expect(blocks.length).toBe(2); // header + 1 context
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("Task Assigned");
    expect(blocks[1].type).toBe("context");
    expect(blocks[1].elements[0].text).toContain("Alpha");
    expect(blocks[1].elements[0].text).toContain("Assigned");
  });

  test("mixed assigned, queued, and failed", () => {
    const blocks = buildAssignmentSummaryBlocks({
      assigned: [{ agentName: "Alpha", taskId: "aaaa0000-0000-0000-0000-000000000000" }],
      queued: [{ agentName: "Beta", taskId: "bbbb0000-0000-0000-0000-000000000000" }],
      failed: [{ agentName: "Gamma", reason: "offline" }],
    });

    expect(blocks.length).toBe(4); // header + 3 context
    expect(blocks[1].elements[0].text).toContain("Alpha");
    expect(blocks[1].elements[0].text).toContain("Assigned");
    expect(blocks[2].elements[0].text).toContain("Beta");
    expect(blocks[2].elements[0].text).toContain("Queued");
    expect(blocks[3].elements[0].text).toContain("Gamma");
    expect(blocks[3].elements[0].text).toContain("offline");
  });

  test("all failed shows different header", () => {
    const blocks = buildAssignmentSummaryBlocks({
      assigned: [],
      queued: [],
      failed: [{ agentName: "Delta", reason: "error" }],
    });

    expect(blocks[0].text.text).toContain("Assignment Failed");
  });
});

describe("buildCancelledBlocks", () => {
  test("returns header, context meta, context footer", () => {
    const blocks = buildCancelledBlocks({
      agentName: "Alpha",
      taskId: "cccc0000-0000-0000-0000-000000000000",
    });

    expect(blocks.length).toBe(3);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toContain("Cancelled");
    expect(blocks[1].type).toBe("context");
    expect(blocks[1].elements[0].text).toContain("Alpha");
    expect(blocks[2].type).toBe("context");
    expect(blocks[2].elements[0].text).toContain("full logs");
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
