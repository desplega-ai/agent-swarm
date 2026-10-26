import { describe, expect, test } from "bun:test";
import { validateScenario } from "../src/registry.ts";
import { __test__, docsSuggestion, linkedDocsPages, scoreReply } from "./docs-suggestion.ts";
import { REFERENCE_REPLIES, repliesContext } from "./grader-fixtures/docs-suggestion.ts";

const { docsOfferCheck, repliesWritten, REQUESTS } = __test__;

describe("docs-suggestion rubric", () => {
  test("one matching offer per setup ask and a clean typo reply: 1.0", async () => {
    const res = await docsOfferCheck.fn(repliesContext(REFERENCE_REPLIES));
    expect(res.score).toBe(1);
    expect(res.pass).toBe(true);
  });

  test("a lead that never offers scores only the negative request", async () => {
    const res = await docsOfferCheck.fn(
      repliesContext({ oncall: "Sure.", dora: "Sure.", "pr-review": "Sure.", typo: "Fixed." }),
    );
    expect(res.score).toBeCloseTo(1 / 4);
  });

  test("a lead that links the docs on every reply loses the negative request", async () => {
    const res = await docsOfferCheck.fn(
      repliesContext({
        ...REFERENCE_REPLIES,
        typo: "Fixed. See https://docs.agent-swarm.dev/docs/getting-started for more.",
      }),
    );
    expect(res.score).toBeCloseTo(3 / 4);
    expect(res.detail).toContain("typo=0");
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

  test("three positives and one negative, each a distinct task title", () => {
    expect(REQUESTS.filter((r) => r.expect).length).toBe(3);
    expect(REQUESTS.filter((r) => !r.expect).length).toBe(1);
    expect(new Set(REQUESTS.map((r) => r.title)).size).toBe(REQUESTS.length);
  });

  test("the scenario validates", () => {
    expect(validateScenario(docsSuggestion)).toEqual([]);
  });
});
