import { describe, expect, test } from "bun:test";
import {
  agentmailContextKey,
  buildJiraContextKey,
  githubContextKey,
  gitlabContextKey,
  linearContextKey,
  parseContextKey,
  scheduleContextKey,
  slackContextKey,
  workflowContextKey,
} from "../tasks/context-key";

describe("context-key builders", () => {
  test("slackContextKey builds expected format", () => {
    expect(slackContextKey({ channelId: "C123", threadTs: "1776800534.257079" })).toBe(
      "task:slack:C123:1776800534.257079",
    );
  });

  test("agentmailContextKey builds expected format", () => {
    expect(agentmailContextKey({ threadId: "thr_abc" })).toBe("task:agentmail:thr_abc");
  });

  test("githubContextKey preserves owner/repo case", () => {
    expect(
      githubContextKey({ owner: "Desplega-AI", repo: "Agent-Swarm", kind: "pr", number: 42 }),
    ).toBe("task:trackers:github:Desplega-AI:Agent-Swarm:pr:42");
  });

  test("gitlabContextKey accepts numeric project id and stringifies it", () => {
    expect(gitlabContextKey({ projectId: 789, kind: "mr", iid: 12 })).toBe(
      "task:trackers:gitlab:789:mr:12",
    );
  });

  test("linearContextKey preserves identifier case", () => {
    expect(linearContextKey({ issueIdentifier: "DES-42" })).toBe("task:trackers:linear:DES-42");
  });

  test("buildJiraContextKey preserves identifier case", () => {
    expect(buildJiraContextKey("PROJ-123")).toBe("task:trackers:jira:PROJ-123");
  });

  test("scheduleContextKey builds expected format", () => {
    expect(scheduleContextKey({ scheduleId: "sched-uuid" })).toBe("task:schedule:sched-uuid");
  });

  test("workflowContextKey builds expected format", () => {
    expect(workflowContextKey({ workflowRunId: "run-uuid" })).toBe("task:workflow:run-uuid");
  });
});

describe("context-key separator safety", () => {
  test("slackContextKey throws when channelId contains ':'", () => {
    expect(() => slackContextKey({ channelId: "C:123", threadTs: "1" })).toThrow(
      /must not contain/,
    );
  });

  test("slackContextKey throws when threadTs contains ':'", () => {
    expect(() => slackContextKey({ channelId: "C1", threadTs: "a:b" })).toThrow(/must not contain/);
  });

  test("githubContextKey throws when repo contains ':'", () => {
    expect(() =>
      githubContextKey({ owner: "desplega", repo: "bad:repo", kind: "pr", number: 1 }),
    ).toThrow(/must not contain/);
  });

  test("agentmailContextKey throws when threadId contains ':'", () => {
    expect(() => agentmailContextKey({ threadId: "thr:bad" })).toThrow(/must not contain/);
  });

  test("linearContextKey throws when identifier contains ':'", () => {
    expect(() => linearContextKey({ issueIdentifier: "DES:42" })).toThrow(/must not contain/);
  });

  test("buildJiraContextKey throws when identifier contains ':'", () => {
    expect(() => buildJiraContextKey("PROJ:123")).toThrow(/must not contain/);
  });

  test("throws on empty values", () => {
    expect(() => slackContextKey({ channelId: "", threadTs: "1" })).toThrow(/non-empty/);
    expect(() => agentmailContextKey({ threadId: "" })).toThrow(/non-empty/);
    expect(() => linearContextKey({ issueIdentifier: "" })).toThrow(/non-empty/);
    expect(() => buildJiraContextKey("")).toThrow(/non-empty/);
  });

  test("githubContextKey validates kind", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => githubContextKey({ owner: "a", repo: "b", kind: "bogus", number: 1 })).toThrow(
      /kind/,
    );
  });

  test("gitlabContextKey validates kind", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => gitlabContextKey({ projectId: "1", kind: "bogus", iid: 1 })).toThrow(/kind/);
  });

  test("githubContextKey rejects non-numeric number", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => githubContextKey({ owner: "a", repo: "b", kind: "pr", number: "abc" })).toThrow(
      /integer/,
    );
  });
});

describe("parseContextKey", () => {
  test("round-trips slack keys", () => {
    const key = slackContextKey({ channelId: "C0A4J7GB0UD", threadTs: "1776800534.257079" });
    const parsed = parseContextKey(key);
    expect(parsed).toEqual({
      family: "slack",
      parts: { channelId: "C0A4J7GB0UD", threadTs: "1776800534.257079" },
    });
  });

  test("round-trips agentmail keys", () => {
    const key = agentmailContextKey({ threadId: "thr_abc" });
    expect(parseContextKey(key)).toEqual({
      family: "agentmail",
      parts: { threadId: "thr_abc" },
    });
  });

  test("round-trips github keys and preserves case", () => {
    const key = githubContextKey({
      owner: "Desplega-AI",
      repo: "Agent-Swarm",
      kind: "issue",
      number: 123,
    });
    expect(parseContextKey(key)).toEqual({
      family: "trackers",
      subFamily: "github",
      parts: { owner: "Desplega-AI", repo: "Agent-Swarm", kind: "issue", number: 123 },
    });
  });

  test("round-trips gitlab keys", () => {
    const key = gitlabContextKey({ projectId: 789, kind: "mr", iid: 7 });
    expect(parseContextKey(key)).toEqual({
      family: "trackers",
      subFamily: "gitlab",
      parts: { projectId: "789", kind: "mr", iid: 7 },
    });
  });

  test("round-trips linear keys with case preserved", () => {
    const key = linearContextKey({ issueIdentifier: "DES-42" });
    expect(parseContextKey(key)).toEqual({
      family: "trackers",
      subFamily: "linear",
      parts: { issueIdentifier: "DES-42" },
    });
  });

  test("round-trips jira keys with case preserved", () => {
    const key = buildJiraContextKey("PROJ-123");
    expect(parseContextKey(key)).toEqual({
      family: "trackers",
      subFamily: "jira",
      parts: { issueIdentifier: "PROJ-123" },
    });
  });

  test("round-trips schedule keys", () => {
    const key = scheduleContextKey({ scheduleId: "sched-1" });
    expect(parseContextKey(key)).toEqual({
      family: "schedule",
      parts: { scheduleId: "sched-1" },
    });
  });

  test("round-trips workflow keys", () => {
    const key = workflowContextKey({ workflowRunId: "run-1" });
    expect(parseContextKey(key)).toEqual({
      family: "workflow",
      parts: { workflowRunId: "run-1" },
    });
  });

  test("throws on malformed keys", () => {
    expect(() => parseContextKey("")).toThrow();
    expect(() => parseContextKey("not-a-task-key")).toThrow();
    expect(() => parseContextKey("task:slack:C1")).toThrow(/slack/);
    expect(() => parseContextKey("task:trackers:bogus:x")).toThrow(/sub-family/);
    expect(() => parseContextKey("task:trackers:github:a:b:weird:1")).toThrow(/kind/);
  });
});
