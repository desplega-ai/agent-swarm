import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MotionGlobalConfig } from "motion/react";
import { act, forwardRef, type ReactNode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import type { ApprovalQuestion } from "../../api/types";

// A DOM for the render and click tests; removed after this file so other
// files keep their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom rejects a cancelled Web Animation, which motion does on unmount.
MotionGlobalConfig.skipAnimations = true;
// Radix picks a no-op layout effect when it first loads with no document.
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file. Factories use require (see
// submit-bar.test.tsx).
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/approval-format", () => require("../../lib/approval-format"));
mock.module("@/lib/approval-shortcuts", () => require("../../lib/approval-shortcuts"));
mock.module("@/components/kibo-ui/spinner", () => require("../../components/kibo-ui/spinner"));
mock.module("@/components/ui/spinner", () => require("../../components/ui/spinner"));
mock.module("@/components/ui/alert-dialog", () => require("../../components/ui/alert-dialog"));
mock.module("@/components/ui/button", () => require("../../components/ui/button"));
mock.module("@/components/ui/tooltip", () => require("../../components/ui/tooltip"));
mock.module("@/components/ui/dialog", () => require("../../components/ui/dialog"));
mock.module("@/components/ui/kbd", () => require("../../components/ui/kbd"));
mock.module("@/components/ui/tabs", () => require("../../components/ui/tabs"));
mock.module("@/components/shared/fade-in", () => require("./fade-in"));
mock.module("@/components/shared/questions/keyboard", () => require("./questions/keyboard"));
// SubmitBar is the real one: these tests cover what QuestionFlow hands it.
mock.module("@/components/shared/questions/submit-bar", () => require("./questions/submit-bar"));
// The cards are out of scope here (and pull in markdown rendering).
mock.module("@/components/shared/questions/question-card", () => ({
  QuestionCard: forwardRef<HTMLElement, { children?: ReactNode }>(({ children }, ref) => (
    <section ref={ref}>{children}</section>
  )),
}));
mock.module("@/components/shared/questions/question-field", () => ({
  QuestionField: () => null,
  optionValues: (question: ApprovalQuestion) =>
    question.type === "boolean" ? ["yes", "no"] : (question.options ?? []).map((o) => o.value),
}));

const { QuestionFlow } = await import("./question-flow");
const { TooltipProvider } = await import("../../components/ui/tooltip");

const textQuestion = { id: "email", type: "text", label: "Email" } as ApprovalQuestion;
const approvalQuestion = { id: "go", type: "approval", label: "Approve?" } as ApprovalQuestion;

async function mount(props: {
  questions: ApprovalQuestion[];
  initialValues?: Record<string, unknown>;
  submitLabel?: string;
  onSubmit?: () => Promise<void>;
  embedded?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <TooltipProvider>
        <QuestionFlow
          questions={props.questions}
          initialValues={props.initialValues}
          submitLabel={props.submitLabel}
          embedded={props.embedded}
          onSubmit={props.onSubmit ?? (async () => {})}
          done={() => <p>Sent</p>}
        />
      </TooltipProvider>,
    );
  });
  // SubmitBar's submit button is the one carrying the Mod+Enter shortcut.
  const submitButton = () =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-keyshortcuts="Control+Enter Meta+Enter"]',
    );
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, submitButton, unmount };
}

describe("QuestionFlow submit label", () => {
  test("submitLabel reaches the SubmitBar button", async () => {
    const view = await mount({
      questions: [textQuestion],
      submitLabel: "Send me the Slack Connect invite",
    });
    const text = view.submitButton()?.textContent ?? "";
    expect(text).toContain("Send me the Slack Connect invite");
    expect(text).not.toContain("Submit");
    await view.unmount();
  });

  test("with no submitLabel the button reads Submit", async () => {
    const view = await mount({ questions: [textQuestion] });
    const text = view.submitButton()?.textContent ?? "";
    expect(text).toContain("Submit");
    expect(text).not.toContain("reject");
    await view.unmount();
  });

  test("with no submitLabel a rejected approval reads Submit · reject", async () => {
    const view = await mount({
      questions: [approvalQuestion],
      initialValues: { go: { approved: false } },
    });
    expect(view.submitButton()?.textContent).toContain("Submit · reject");
    await view.unmount();
  });

  test("a click on the labelled button submits the flow", async () => {
    const onSubmit = mock(async () => {});
    const view = await mount({
      questions: [textQuestion],
      initialValues: { email: "demo@example.com" },
      submitLabel: "Send me the Slack Connect invite",
      onSubmit,
    });
    await act(async () => view.submitButton()?.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ email: "demo@example.com" });
    await view.unmount();
  });
});

describe("QuestionFlow embedded", () => {
  test("one tab per question, an answered mark, one panel shown", async () => {
    const view = await mount({
      questions: [approvalQuestion, textQuestion],
      initialValues: { go: { approved: true } },
      embedded: true,
    });
    const tabs = [...view.container.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "Question 1, answered",
      "Question 2",
    ]);
    // The first open question is the selected tab; the other panel is hidden.
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    const panels = [...view.container.querySelectorAll('[role="tabpanel"]')];
    expect(panels.map((panel) => panel.getAttribute("data-state"))).toEqual(["inactive", "active"]);
    expect(view.submitButton()).not.toBeNull();
    await view.unmount();
  });

  test("a single question shows no tab strip", async () => {
    const view = await mount({ questions: [textQuestion], embedded: true });
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    await view.unmount();
  });
});
