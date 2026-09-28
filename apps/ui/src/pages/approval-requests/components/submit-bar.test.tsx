import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file.
mock.module("@/lib/utils", () => import("../../../lib/utils"));

mock.module("@/components/ui/alert-dialog", () => import("../../../components/ui/alert-dialog"));
mock.module("@/components/ui/button", () => import("../../../components/ui/button"));
mock.module("@/components/ui/tooltip", () => import("../../../components/ui/tooltip"));
mock.module("@/components/ui/dialog", () => import("../../../components/ui/dialog"));
mock.module("@/components/ui/kbd", () => import("../../../components/ui/kbd"));
mock.module("@/lib/approval-shortcuts", () => import("../../../lib/approval-shortcuts"));
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

describe("SubmitBar Discard", () => {
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
