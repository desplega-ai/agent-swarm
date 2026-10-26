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
