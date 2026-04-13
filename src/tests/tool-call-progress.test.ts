import { describe, expect, test } from "bun:test";
import { humanizeToolName, toolCallToProgress } from "../commands/runner";

describe("toolCallToProgress", () => {
  // --- Core Claude Code tools ---

  test("Read tool includes emoji and short path", () => {
    const result = toolCallToProgress("Read", {
      file_path: "/Users/taras/Documents/code/agent-swarm/src/commands/runner.ts",
    });
    expect(result).toBe("📖 Reading commands/runner.ts");
  });

  test("Edit tool includes emoji and short path", () => {
    const result = toolCallToProgress("Edit", {
      file_path: "/Users/taras/code/src/index.ts",
    });
    expect(result).toBe("✏️ Editing src/index.ts");
  });

  test("MultiEdit uses same format as Edit", () => {
    const result = toolCallToProgress("MultiEdit", {
      file_path: "/a/b/c/d.ts",
    });
    expect(result).toBe("✏️ Editing c/d.ts");
  });

  test("Write tool includes emoji and short path", () => {
    const result = toolCallToProgress("Write", {
      file_path: "/Users/taras/code/new-file.ts",
    });
    expect(result).toBe("📝 Writing code/new-file.ts");
  });

  test("Bash tool uses description when available", () => {
    const result = toolCallToProgress("Bash", {
      description: "Running tests",
      command: "bun test",
    });
    expect(result).toBe("⚡ Running tests");
  });

  test("Bash tool falls back when no description", () => {
    const result = toolCallToProgress("Bash", { command: "ls -la" });
    expect(result).toBe("⚡ Running shell command");
  });

  test("Grep tool shows search pattern", () => {
    const result = toolCallToProgress("Grep", { pattern: "TODO" });
    expect(result).toBe('🔍 Searching for "TODO"');
  });

  test("Glob tool shows file pattern", () => {
    const result = toolCallToProgress("Glob", { pattern: "**/*.test.ts" });
    expect(result).toBe("📁 Finding files matching **/*.test.ts");
  });

  test("Agent tool uses description when available", () => {
    const result = toolCallToProgress("Agent", {
      description: "Exploring codebase structure",
    });
    expect(result).toBe("🤖 Exploring codebase structure");
  });

  test("Agent tool falls back when no description", () => {
    const result = toolCallToProgress("Agent", {});
    expect(result).toBe("🤖 Delegating sub-task");
  });

  test("Task tool uses description", () => {
    const result = toolCallToProgress("Task", {
      description: "Running lint checks",
    });
    expect(result).toBe("🤖 Running lint checks");
  });

  test("Skill tool shows skill name", () => {
    const result = toolCallToProgress("Skill", { skill: "commit" });
    expect(result).toBe("⚙️ Running /commit");
  });

  // --- Skip list ---

  test("ToolSearch is skipped (returns null)", () => {
    expect(toolCallToProgress("ToolSearch", {})).toBeNull();
  });

  test("TodoRead is skipped", () => {
    expect(toolCallToProgress("TodoRead", {})).toBeNull();
  });

  test("TodoWrite is skipped", () => {
    expect(toolCallToProgress("TodoWrite", {})).toBeNull();
  });

  // --- Unknown default tools ---

  test("unknown tool gets fallback with emoji", () => {
    const result = toolCallToProgress("SomeNewTool", {});
    expect(result).toBe("🔧 SomeNewTool");
  });

  // --- Agent-swarm MCP tools (with pretty labels) ---

  test("agent-swarm:get-task-details has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__get-task-details", {});
    expect(result).toBe("📋 Reviewing task details");
  });

  test("agent-swarm:send-task has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__send-task", {});
    expect(result).toBe("📤 Delegating task");
  });

  test("agent-swarm:post-message has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__post-message", {});
    expect(result).toBe("💬 Sending message");
  });

  test("agent-swarm:store-progress is skipped (meta/noise)", () => {
    expect(toolCallToProgress("mcp__agent-swarm__store-progress", {})).toBeNull();
  });

  test("agent-swarm:poll-task has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__poll-task", {});
    expect(result).toBe("📡 Polling for tasks");
  });

  test("agent-swarm:request-human-input has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__request-human-input", {});
    expect(result).toBe("🙋 Requesting human input");
  });

  test("agent-swarm:memory-search has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__memory-search", {});
    expect(result).toBe("🧠 Searching memory");
  });

  test("agent-swarm:tracker-status has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__tracker-status", {});
    expect(result).toBe("📊 Checking tracker status");
  });

  test("agent-swarm:trigger-workflow has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__trigger-workflow", {});
    expect(result).toBe("⚙️ Triggering workflow");
  });

  test("agent-swarm:slack-post has pretty label", () => {
    const result = toolCallToProgress("mcp__agent-swarm__slack-post", {});
    expect(result).toBe("💬 Posting to Slack");
  });

  // --- Agent-swarm MCP tool NOT in lookup (humanized fallback) ---

  test("unknown agent-swarm tool gets humanized fallback", () => {
    const result = toolCallToProgress("mcp__agent-swarm__some-new-tool", {});
    expect(result).toBe("🔌 Some new tool");
  });

  // --- Other MCP servers ---

  test("other MCP server tool gets server prefix + humanized name", () => {
    const result = toolCallToProgress("mcp__linear__list-issues", {});
    expect(result).toBe("🔌 linear: List issues");
  });

  test("other MCP server with simple tool name", () => {
    const result = toolCallToProgress("mcp__github__search", {});
    expect(result).toBe("🔌 github: Search");
  });

  test("MCP tool with double underscores in tool name", () => {
    const result = toolCallToProgress("mcp__context7__query-docs", {});
    expect(result).toBe("🔌 context7: Query docs");
  });

  // --- Short path helper (tested implicitly) ---

  test("Read with short path (<=2 segments) keeps full path", () => {
    const result = toolCallToProgress("Read", { file_path: "file.ts" });
    expect(result).toBe("📖 Reading file.ts");
  });

  test("Read with missing file_path shows empty", () => {
    const result = toolCallToProgress("Read", {});
    expect(result).toBe("📖 Reading ");
  });
});

describe("humanizeToolName", () => {
  test("converts kebab-case to sentence case", () => {
    expect(humanizeToolName("get-task-details")).toBe("Get task details");
  });

  test("single word gets capitalized", () => {
    expect(humanizeToolName("search")).toBe("Search");
  });

  test("multi-word kebab-case", () => {
    expect(humanizeToolName("list-all-workflow-runs")).toBe("List all workflow runs");
  });

  test("empty string returns empty", () => {
    expect(humanizeToolName("")).toBe("");
  });
});
