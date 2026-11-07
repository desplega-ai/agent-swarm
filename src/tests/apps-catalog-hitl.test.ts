import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

type Element = { type: string; props: Record<string, unknown>; [key: string]: unknown };

function definitionWith(approve: Element) {
  return {
    models: { deploy: { columns: { title: { kind: "string" } } } },
    actions: {
      requestDeploy: { kind: "task", prompt: "Ask a person to approve the deploy" },
      applyDecision: { kind: "task", prompt: "Apply the deploy decision" },
    },
    pages: {
      main: {
        title: "Deploys",
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["approve"] },
          approve,
        },
      },
    },
    defaultPage: "main",
  };
}

const validApproval: Element = {
  type: "Approval",
  props: {
    requestId: { $state: "/actions/requestDeploy/result/requestId" },
    showResolved: true,
    compact: false,
    onResolved: [
      {
        action: "app.action",
        params: {
          name: "applyDecision",
          input: {
            status: { $chain: "status" },
            responses: { $chain: "responses" },
            decision: { $chain: "responses/go" },
            by: { $chain: "resolvedBy" },
          },
        },
      },
      { action: "ui.toast", params: { message: "Decision applied", tone: "success" } },
    ],
  },
};

async function issuesFor(approve: Element) {
  const parsed = await parseAppDefinition(definitionWith(approve));
  return parsed.success ? [] : parsed.issues;
}

const at = "pages.main.elements.approve";

describe("Approval catalog component", () => {
  test("a page binding requestId to an action result with an onResolved chain is valid", async () => {
    const issues = await issuesFor(validApproval);
    if (issues.length > 0) console.error(issues);
    expect(issues).toEqual([]);
  });

  test("a literal (even empty) requestId alone is valid", async () => {
    expect(await issuesFor({ type: "Approval", props: { requestId: "" } })).toEqual([]);
  });

  test("a missing requestId is rejected", async () => {
    const issues = await issuesFor({ type: "Approval", props: { compact: true } });
    expect(issues.some((found) => found.path.startsWith(`${at}.props`))).toBe(true);
  });

  test("an unknown $chain key in onResolved is rejected", async () => {
    const approve = structuredClone(validApproval);
    const steps = approve.props.onResolved as { params: { input: Record<string, unknown> } }[];
    steps[0]!.params.input.status = { $chain: "leafTaskId" };
    steps[0]!.params.input.by = { $chain: "responses.go" };
    const issues = await issuesFor(approve);
    expect(issues.map((found) => found.path).sort()).toEqual([
      `${at}.props.onResolved.0.params.input.by`,
      `${at}.props.onResolved.0.params.input.status`,
    ]);
    expect(issues[0]!.message).toContain("unknown $chain key");
  });

  test("on.resolved is rejected with a pointer to props.onResolved", async () => {
    const approve: Element = {
      type: "Approval",
      props: { requestId: "abc" },
      on: { resolved: [{ action: "ui.toast", params: { message: "Done" } }] },
    };
    const issues = await issuesFor(approve);
    expect(issues).toEqual([
      {
        path: `${at}.on.resolved`,
        message: "Approval runs its resolved chain from props.onResolved, not on.resolved",
      },
    ]);
  });

  test("onResolved steps are validated like any chain (unknown action name)", async () => {
    const approve = structuredClone(validApproval);
    const steps = approve.props.onResolved as { params: { name?: string } }[];
    steps[0]!.params.name = "notDeclared";
    const issues = await issuesFor(approve);
    expect(issues.map((found) => found.path)).toContain(`${at}.props.onResolved.0.params.name`);
  });

  test("an unknown Approval prop is rejected", async () => {
    const issues = await issuesFor({
      type: "Approval",
      props: { requestId: "abc", autoApprove: true },
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});
