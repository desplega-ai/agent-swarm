/**
 * What the task page does once a follow-up task exists. A clean send moves
 * the page to the new task. A send whose attachments did not all upload
 * stays: the composer keeps those files and the error for a retry, and
 * leaving the page would drop them. The toast still opens the new task.
 */
export function announceFollowUpTask(
  created: { id: string },
  outcome: { attachmentsFailed: boolean },
  deps: {
    navigate: (to: string) => void;
    notify: (message: string, action?: { label: string; onClick: () => void }) => void;
  },
): void {
  const to = `/tasks/${created.id}`;
  if (outcome.attachmentsFailed) {
    deps.notify("Follow-up task created.", { label: "Open", onClick: () => deps.navigate(to) });
    return;
  }
  deps.notify("Follow-up task created.");
  deps.navigate(to);
}
