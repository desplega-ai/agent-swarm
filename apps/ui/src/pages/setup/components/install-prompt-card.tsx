import { Check, Copy, SquareTerminal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { SetupCard } from "@/components/shared/setup-card";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * The install prompt of the landing page (`PROMPT_TEXT` in
 * agent-swarm-landing/src/lib/landing-v2-copy.ts). Keep the two in sync.
 */
export const INSTALL_PROMPT =
  "Read https://agent-swarm.dev/skill.md and help me install and operate Agent Swarm on our infra. Ask about my setup before running anything.";

/**
 * Step 1 with no connection yet: the first way to get a swarm. The person
 * pastes the prompt in a coding agent, which installs the swarm and ends with
 * a dashboard link that fills in the connect form.
 */
export function InstallPromptCard() {
  const { copied, copy } = useCopyToClipboard();
  const [copyFailed, setCopyFailed] = useState(false);

  return (
    <SetupCard
      icon={<SquareTerminal className="size-4" />}
      title="Ask your coding agent"
      description="It reads our skill, asks about your setup, then installs the swarm."
    >
      <div className="flex flex-col gap-3">
        <p className="rounded-lg border border-border-subtle bg-surface px-3.5 py-3 font-mono text-data leading-relaxed text-foreground">
          {INSTALL_PROMPT}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* One width: only the icon swaps, the label stays. */}
          <Button
            type="button"
            onClick={async () => setCopyFailed(!(await copy(INSTALL_PROMPT)))}
            aria-label={copied ? "Copied" : "Copy install prompt"}
          >
            {copied ? <Check /> : <Copy />}
            Copy prompt
          </Button>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {copyFailed
              ? "Could not copy. Select the text and copy it."
              : "Paste it in Claude Code, Codex, or any coding agent."}
          </p>
        </div>
      </div>
    </SetupCard>
  );
}

/** A quiet "or" between two ways to do the same thing. */
export function OrDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border-subtle" />
      {children}
      <span aria-hidden className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}
