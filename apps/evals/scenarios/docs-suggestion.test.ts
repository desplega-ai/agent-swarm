import { describe, expect, test } from "bun:test";
import { validateScenario } from "../src/registry.ts";
import {
  __test__,
  docsSuggestion,
  linkedDocsPages,
  loadedSwarmDocs,
  scoreReply,
} from "./docs-suggestion.ts";
import { REFERENCE_REPLIES, repliesContext, taskIdFor } from "./grader-fixtures/docs-suggestion.ts";
import { toolCallRows } from "./grader-validation-support.ts";

const { docsOfferCheck, repliesWritten, REQUESTS } = __test__;

describe("docs-suggestion rubric", () => {
  test("one matching offer per setup ask and clean negative replies: 1.0", async () => {
    const res = await docsOfferCheck.fn(repliesContext(REFERENCE_REPLIES));
    expect(res.score).toBe(1);
    expect(res.pass).toBe(true);
  });

  test("a lead that never offers scores only the negative requests", async () => {
    const res = await docsOfferCheck.fn(
      repliesContext({
        oncall: "Sure.",
        dora: "Sure.",
        "pr-review": "Sure.",
        typo: "Fixed.",
        reminder: "Scheduled.",
      }),
    );
    expect(res.score).toBeCloseTo(2 / 5);
  });

  test("a lead that links the docs on every reply loses the negative request", async () => {
    const res = await docsOfferCheck.fn(
      repliesContext({
        ...REFERENCE_REPLIES,
        typo: "Fixed. See https://docs.agent-swarm.dev/docs/getting-started for more.",
      }),
    );
    expect(res.score).toBeCloseTo(4 / 5);
    expect(res.detail).toContain("typo=0");
  });

  test("loading swarm-docs for an ask a skill already covers loses that request", async () => {
    const taskId = taskIdFor("reminder");
    const res = await docsOfferCheck.fn(
      repliesContext(REFERENCE_REPLIES, {
        [taskId]: toolCallRows(taskId, "Skill", { skill: "swarm-docs" }, "loaded", "c1"),
      }),
    );
    expect(res.score).toBeCloseTo(4 / 5);
    expect(res.detail).toContain("reminder=0 (loaded swarm-docs");
  });

  test("loading swarm-docs for a matching setup ask costs nothing", async () => {
    const taskId = taskIdFor("oncall");
    const res = await docsOfferCheck.fn(
      repliesContext(REFERENCE_REPLIES, {
        [taskId]: toolCallRows(taskId, "Skill", { skill: "swarm-docs" }, "loaded", "c1"),
      }),
    );
    expect(res.score).toBe(1);
  });

  test("a skill load shows through the Skill tool, skill-get, or a read of its file", () => {
    expect(loadedSwarmDocs([{ toolName: "Skill", input: { skill: "swarm-docs" } }])).toBe(true);
    expect(
      loadedSwarmDocs([{ toolName: "mcp__agent-swarm__skill-get", input: { name: "swarm-docs" } }]),
    ).toBe(true);
    expect(
      loadedSwarmDocs([
        {
          toolName: "Read",
          input: { file_path: "/home/worker/.claude/skills/swarm-docs/SKILL.md" },
        },
      ]),
    ).toBe(true);
    expect(loadedSwarmDocs([{ toolName: "Skill", input: { skill: "scheduling" } }])).toBe(false);
  });

  test("a search or grep that only mentions swarm-docs is not a skill load", () => {
    expect(
      loadedSwarmDocs([
        { toolName: "mcp__agent-swarm__skill-search", input: { query: "swarm-docs" } },
      ]),
    ).toBe(false);
    expect(
      loadedSwarmDocs([
        { toolName: "Grep", input: { pattern: "swarm-docs", path: "/home/worker/.claude/skills" } },
      ]),
    ).toBe(false);
    expect(
      loadedSwarmDocs([{ toolName: "Read", input: { file_path: "/notes/swarm-docs-todo.md" } }]),
    ).toBe(false);
  });

  describe("Codex and Pi session logs, parsed then graded", () => {
    const taskId = taskIdFor("reminder");
    const gradeRaw = (line: unknown) =>
      docsOfferCheck.fn(
        repliesContext(REFERENCE_REPLIES, {
          [taskId]: [{ taskId, content: JSON.stringify(line) }],
        }),
      );
    const codexItem = (item: Record<string, unknown>) => ({
      type: "item.completed",
      item: { id: "i1", status: "completed", ...item },
    });
    const piToolUse = (name: string, input: Record<string, unknown>) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "p1", name, input }] },
    });

    const loads: [string, unknown][] = [
      [
        "Codex MCP skill-get",
        codexItem({
          type: "mcp_tool_call",
          server: "agent-swarm",
          tool: "skill-get",
          arguments: { name: "swarm-docs" },
          result: "loaded",
        }),
      ],
      [
        "Codex shell cat of the skill file",
        codexItem({
          type: "command_execution",
          command: "/bin/bash -lc 'cat /home/worker/.codex/skills/swarm-docs/SKILL.md'",
          exit_code: 0,
        }),
      ],
      [
        "Codex shell sed of the skill file",
        codexItem({
          type: "command_execution",
          command: "sed -n '1,200p' /home/worker/.codex/skills/swarm-docs/SKILL.md",
          exit_code: 0,
        }),
      ],
      [
        "Codex shell cat on the second line of the command",
        codexItem({
          type: "command_execution",
          command: "/bin/bash -lc 'pwd\ncat /home/worker/.codex/skills/swarm-docs/SKILL.md'",
          exit_code: 0,
        }),
      ],
      [
        "Pi bash cat after a newline",
        piToolUse("bash", {
          command: "pwd\ncat /home/worker/.pi/agent/skills/swarm-docs/SKILL.md",
        }),
      ],
      [
        "Pi bash cat after && and an env assignment",
        piToolUse("bash", {
          command: "cd /tmp && LC_ALL=C head -50 /home/worker/.pi/agent/skills/swarm-docs/SKILL.md",
        }),
      ],
      [
        "Pi bash cat of the skill file",
        piToolUse("bash", { command: "cat /home/worker/.pi/agent/skills/swarm-docs/SKILL.md" }),
      ],
      [
        "Pi read of the skill file",
        piToolUse("read", { path: "/home/worker/.pi/agent/skills/swarm-docs/SKILL.md" }),
      ],
      ["Pi skill-get", piToolUse("skill-get", { name: "swarm-docs" })],
      [
        "opencode read of the skill file",
        {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "read",
              callID: "o1",
              state: {
                status: "completed",
                input: { filePath: "/home/worker/.config/opencode/skills/swarm-docs/SKILL.md" },
              },
            },
          },
        },
      ],
    ];
    for (const [name, line] of loads) {
      test(`${name} counts as a swarm-docs load`, async () => {
        const res = await gradeRaw(line);
        expect(res.score).toBeCloseTo(4 / 5);
        expect(res.detail).toContain("reminder=0 (loaded swarm-docs");
      });
    }

    const nonLoads: [string, unknown][] = [
      [
        "Codex MCP skill-search",
        codexItem({
          type: "mcp_tool_call",
          server: "agent-swarm",
          tool: "skill-search",
          arguments: { query: "swarm-docs" },
        }),
      ],
      [
        "Codex shell grep over the skills directory",
        codexItem({
          type: "command_execution",
          command: "grep -rl swarm-docs /home/worker/.codex/skills",
          exit_code: 0,
        }),
      ],
      [
        "Codex shell grep inside the skill file",
        codexItem({
          type: "command_execution",
          command: "grep -n cron /home/worker/.codex/skills/swarm-docs/SKILL.md",
          exit_code: 0,
        }),
      ],
      [
        "Codex shell grep whose quoted pattern names a cat of the skill file",
        codexItem({
          type: "command_execution",
          command:
            "/bin/bash -lc \"grep 'cat /home/worker/.codex/skills/swarm-docs/SKILL.md' notes\"",
          exit_code: 0,
        }),
      ],
      [
        "Pi bash grep whose quoted pattern names a cat of the skill file",
        piToolUse("bash", { command: "grep 'cat /x/swarm-docs/SKILL.md' notes" }),
      ],
      [
        "Pi bash echo of a cat command",
        piToolUse("bash", { command: 'echo "cat /x/swarm-docs/SKILL.md"' }),
      ],
      [
        "Pi bash ls of the skill file",
        piToolUse("bash", { command: "ls /home/worker/.pi/agent/skills/swarm-docs/SKILL.md" }),
      ],
      [
        "Pi bash cat of another file",
        piToolUse("bash", { command: "cat /notes/swarm-docs-todo.md" }),
      ],
    ];
    for (const [name, line] of nonLoads) {
      test(`${name} is not a swarm-docs load`, async () => {
        const res = await gradeRaw(line);
        expect(res.score).toBe(1);
      });
    }
  });

  test("a list of pages gets half; the wrong playbook gets zero", () => {
    const list =
      "Options: https://docs.agent-swarm.dev/docs/playbooks/open-oncall and https://docs.agent-swarm.dev/docs/playbooks/code-health-alert-management";
    expect(scoreReply(list, "playbooks/open-oncall").score).toBe(0.5);
    expect(
      scoreReply(
        "https://docs.agent-swarm.dev/docs/playbooks/code-health-reports",
        "playbooks/dora-metrics",
      ).score,
    ).toBe(0);
  });

  test("the llms.mdx markdown link and a trailing slash count as the same page", () => {
    expect(
      linkedDocsPages(
        "https://docs.agent-swarm.dev/llms.mdx/docs/playbooks/pr-review and https://docs.agent-swarm.dev/docs/playbooks/pr-review/",
      ),
    ).toEqual(["playbooks/pr-review"]);
  });

  test("an empty reply fails the gate", async () => {
    const res = await repliesWritten.fn(repliesContext({ ...REFERENCE_REPLIES, dora: "" }));
    expect(res.pass).toBe(false);
    expect(res.detail).toContain("dora");
  });

  test("the requests do not leak a playbook, a docs page or the docs site", () => {
    for (const task of docsSuggestion.tasks) {
      const text = `${task.title}\n${task.description}`;
      expect(text).not.toMatch(/playbook|docs\.agent-swarm|oncall|on-call|dora|swarm-docs|guide/i);
    }
  });

  test("three positives and two negatives, each a distinct task title", () => {
    expect(REQUESTS.filter((r) => r.expect).length).toBe(3);
    expect(REQUESTS.filter((r) => !r.expect).length).toBe(2);
    expect(new Set(REQUESTS.map((r) => r.title)).size).toBe(REQUESTS.length);
  });

  test("the scenario validates", () => {
    expect(validateScenario(docsSuggestion)).toEqual([]);
  });
});
