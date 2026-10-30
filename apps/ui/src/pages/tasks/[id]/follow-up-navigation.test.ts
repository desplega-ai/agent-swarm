import { describe, expect, test } from "bun:test";
import { announceFollowUpTask } from "./follow-up-navigation";

function run(attachmentsFailed: boolean) {
  const went: string[] = [];
  const toasts: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  announceFollowUpTask(
    { id: "next-1" },
    { attachmentsFailed },
    {
      navigate: (to) => went.push(to),
      notify: (message, action) => toasts.push({ message, action }),
    },
  );
  return { went, toasts };
}

describe("announceFollowUpTask", () => {
  test("a clean send moves the page to the new task", () => {
    const { went, toasts } = run(false);
    expect(went).toEqual(["/tasks/next-1"]);
    expect(toasts).toEqual([{ message: "Follow-up task created.", action: undefined }]);
  });

  test("a failed upload stays on the page, so the composer keeps its files", () => {
    const { went, toasts } = run(true);
    expect(went).toEqual([]);
    expect(toasts[0]?.action?.label).toBe("Open");
    toasts[0]?.action?.onClick();
    expect(went).toEqual(["/tasks/next-1"]);
  });
});
