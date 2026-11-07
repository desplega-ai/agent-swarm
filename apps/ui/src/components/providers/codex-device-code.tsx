import { ExternalLink } from "lucide-react";
import type { CodexDeviceStartResponse } from "@/api/types";
import { CopyIconButton } from "@/components/shared/copy-icon-button";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";

/** The ChatGPT device code, the verification link (new tab) and the waiting line. */
export function DeviceCodePanel({ flow }: { flow: CodexDeviceStartResponse }) {
  const urlLabel = flow.verificationUrl.replace(/^https?:\/\//, "");
  // Re-read on every render; the caller re-renders on each poll.
  const minutes = Math.ceil((Date.parse(flow.expiresAt) - Date.now()) / 60_000);
  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-center justify-center gap-3">
        <span className="font-mono text-[28px] leading-none font-bold tracking-[0.18em]">
          {flow.userCode}
        </span>
        <CopyIconButton value={flow.userCode} label="Copy code" />
      </div>
      <p className="text-center text-sm text-muted-foreground">
        Enter this one-time code.
        {minutes > 0 ? ` It expires in ${minutes} minute${minutes === 1 ? "" : "s"}.` : null}
      </p>
      <div className="flex justify-center">
        <Button asChild variant="outline" size="sm">
          <a href={flow.verificationUrl} target="_blank" rel="noreferrer noopener">
            Open {urlLabel}
            <ExternalLink />
          </a>
        </Button>
      </div>
      <output className="block border-t border-dashed border-border pt-3">
        <StatusLine tone="busy">Waiting for you to approve in ChatGPT…</StatusLine>
      </output>
    </div>
  );
}
