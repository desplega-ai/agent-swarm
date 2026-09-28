import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MotionGlobalConfig } from "motion/react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

// A DOM for the click test; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom rejects a cancelled Web Animation, which motion does on unmount.
MotionGlobalConfig.skipAnimations = true;
// Radix picks a no-op layout effect when it first loads with no document. An
// earlier server-render test file in the same run leaves that no-op behind,
// and the dialog portal then never mounts.
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file.
// Factories use require, not `() => import()`: Bun hangs when a later test
// file in the same run re-registers an alias with an async factory.
mock.module("@/lib/utils", () => require("../../../lib/utils"));
mock.module("@/components/kibo-ui/spinner", () => require("../../../components/kibo-ui/spinner"));
mock.module("@/components/ui/spinner", () => require("../../../components/ui/spinner"));

mock.module("@/components/ui/alert-dialog", () => require("../../../components/ui/alert-dialog"));
mock.module("@/components/ui/button", () => require("../../../components/ui/button"));
mock.module("@/components/ui/tooltip", () => require("../../../components/ui/tooltip"));
mock.module("@/components/ui/dialog", () => require("../../../components/ui/dialog"));
mock.module("@/components/ui/kbd", () => require("../../../components/ui/kbd"));
mock.module("@/lib/approval-shortcuts", () => require("../../../lib/approval-shortcuts"));
const { DISCARD_DIALOG_TITLE, DISCARD_REASON, SubmitBar, discardDialogLines } = await import(
  "./submit-bar"
);
const { TooltipProvider } = await import("../../../components/ui/tooltip");

const progress = { answered: 0, total: 1, rejects: false, blockedReason: null };

function render(status: "pending" | "cancelled"): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SubmitBar
        request={{ status, workflowRunId: null }}
        progress={progress as never}
        submitting={false}
        discarding={false}
        error={null}
        onSubmit={() => {}}
        onDiscard={() => {}}
      />
    </TooltipProvider>,
  );
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw new Error(`No button with the text ${text}`);
  return button;
}

describe("SubmitBar Discard", () => {
  test("a click on Discard opens the confirmation; confirming calls onDiscard", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onDiscard = mock(() => {});
    await act(async () => {
      root.render(
        <TooltipProvider>
          <SubmitBar
            request={{ status: "pending", workflowRunId: "run-1" }}
            progress={progress as never}
            submitting={false}
            discarding={false}
            error={null}
            onSubmit={() => {}}
            onDiscard={onDiscard}
          />
        </TooltipProvider>,
      );
    });

    expect(document.body.textContent).not.toContain(DISCARD_DIALOG_TITLE);
    await act(async () => buttonWithText(container, "Discard").click());
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(DISCARD_DIALOG_TITLE);
    expect(dialog?.textContent).toContain("Discard cancels that run too.");
    expect(onDiscard).not.toHaveBeenCalled();

    await act(async () => buttonWithText(dialog!, "Discard").click());
    expect(onDiscard).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    container.remove();
  });

  test("a pending request offers Discard", () => {
    expect(render("pending")).toContain("Discard");
  });

  test("a cancelled request offers no Discard", () => {
    expect(render("cancelled")).not.toContain("Discard");
  });

  test("the confirmation names what Discard does", () => {
    expect(DISCARD_DIALOG_TITLE).toBe("Discard this request?");
    expect(DISCARD_REASON).toBe("Discarded from the dashboard");
    expect(discardDialogLines({ workflowRunId: null })).toEqual([
      "The request becomes cancelled. The agent gets no answer.",
    ]);
    expect(discardDialogLines({ workflowRunId: "run-1" })).toEqual([
      "The request becomes cancelled. The agent gets no answer.",
      "This request gates workflow run run-1. Discard cancels that run too.",
    ]);
  });
});
