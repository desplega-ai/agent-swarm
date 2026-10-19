import { expect, test } from "bun:test";
import {
  SLACK_CONNECT_FAILURE_WINDOW_MS,
  SLACK_CONNECT_FIRST_WORKFLOW_MAX_RUNS,
  slackConnectMoment,
} from "./slack-connect-moment";

const nowMs = Date.parse("2026-10-18T12:00:00.000Z");

test("a task that failed in the last 7 days wins", () => {
  const lastFailedAt = new Date(nowMs - 60_000).toISOString();
  expect(slackConnectMoment({ lastFailedAt, workflowRunsCompleted: 3, nowMs })).toBe("task_failed");
});

test("an older failure falls through to the first workflow, then to default", () => {
  const lastFailedAt = new Date(nowMs - SLACK_CONNECT_FAILURE_WINDOW_MS).toISOString();
  expect(slackConnectMoment({ lastFailedAt, workflowRunsCompleted: 1, nowMs })).toBe(
    "first_workflow",
  );
  expect(slackConnectMoment({ lastFailedAt, workflowRunsCompleted: 0, nowMs })).toBe("default");
});

test("no failed task and no workflow run is the plain invite", () => {
  expect(slackConnectMoment({ lastFailedAt: null, workflowRunsCompleted: 0, nowMs })).toBe(
    "default",
  );
});

test("only the first few workflow runs count as the first workflow", () => {
  const moment = (workflowRunsCompleted: number) =>
    slackConnectMoment({ lastFailedAt: null, workflowRunsCompleted, nowMs });
  expect(moment(1)).toBe("first_workflow");
  expect(moment(SLACK_CONNECT_FIRST_WORKFLOW_MAX_RUNS)).toBe("first_workflow");
  expect(moment(SLACK_CONNECT_FIRST_WORKFLOW_MAX_RUNS + 1)).toBe("default");
  expect(moment(250)).toBe("default");
});
