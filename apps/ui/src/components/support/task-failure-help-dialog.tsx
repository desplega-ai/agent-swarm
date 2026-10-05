import { Check, Copy, ExternalLink, LifeBuoy, Mail } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import type { AgentTask } from "@/api/types";
import { MarkdownView } from "@/components/shared/markdown-view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useLeadCredentialIssue } from "@/hooks/use-lead-credential-issue";
import { SUPPORT_DISCORD_URL, SUPPORT_EMAIL } from "@/lib/task-support";

/** The plain-text summary that "Copy diagnostics" puts on the clipboard. */
export function buildDiagnostics(task: AgentTask, apiVersion: string | null): string {
  return [
    "Agent Swarm task diagnostics",
    `Task: ${task.id}`,
    `API version: ${apiVersion ?? task.swarmVersion ?? "unknown"}`,
    `Provider: ${task.provider ?? "unknown"}`,
    `Harness variant: ${task.harnessVariant ?? "unknown"}`,
    `Failure: ${task.failureReason ?? "No failure reason recorded"}`,
  ].join("\n");
}

/**
 * Support options for a failed task. It opens only from "Get help", never on
 * its own. `shouldShowTaskFailureHelp` decides whether a task offers it.
 */
export function TaskFailureHelpDialog({
  task,
  open,
  onOpenChange,
}: {
  task: AgentTask;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { apiVersion } = useLeadCredentialIssue();
  const { copied, copy } = useCopyToClipboard();
  const diagnostics = buildDiagnostics(task, apiVersion);
  // A button outside the dialog opens it (there is no DialogTrigger), so the
  // dialog remembers that button and gives it focus back on close. A menu item
  // closes with its menu, so the menu's trigger takes its place.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const menuId = active?.closest('[role="menu"]')?.id;
    const menuTrigger = menuId
      ? document.querySelector(`[aria-controls="${CSS.escape(menuId)}"]`)
      : null;
    const opener = menuTrigger ?? active;
    openerRef.current = opener instanceof HTMLElement ? opener : null;
  }, [open]);
  const emailHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Agent Swarm task failed")}&body=${encodeURIComponent(diagnostics)}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          if (!opener?.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2 text-status-error-strong">
            <LifeBuoy className="size-5" aria-hidden="true" />
            <DialogTitle>Need help?</DialogTitle>
          </div>
          <DialogDescription>
            This task failed. Share the diagnostics with the Agent Swarm community or email us and
            we’ll help you get unstuck.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-48 overflow-auto rounded-md border border-status-error/30 bg-status-error/5 p-3 text-sm text-status-error-strong/80">
          <MarkdownView text={task.failureReason ?? "No failure reason was recorded."} />
        </div>

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="outline" onClick={() => void copy(diagnostics)}>
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? "Copied" : "Copy diagnostics"}
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button asChild variant="outline">
              <a href={emailHref}>
                <Mail aria-hidden="true" />
                Email us
              </a>
            </Button>
            <Button asChild>
              <a href={SUPPORT_DISCORD_URL} target="_blank" rel="noreferrer">
                Join Discord
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
