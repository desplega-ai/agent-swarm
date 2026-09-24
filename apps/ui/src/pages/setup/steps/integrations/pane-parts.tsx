import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { StatusLine } from "@/components/onboarding/save-indicator";
import { CollapsibleSection } from "@/components/shared/collapsible-section";

/** Inline external link in helper copy. Always a new tab. */
export function ExternalTextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

/** Numbered instruction line for the OAuth panes. */
export function StepLine({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] text-muted-foreground">
        {n}
      </span>
      <span className="pt-px">{children}</span>
    </div>
  );
}

/** Connected: one success line, with the fields folded under "Edit settings". */
export function ConnectedGate({
  connected,
  summary,
  children,
}: {
  connected: boolean;
  /** A few words, e.g. "Connected. Mention the bot in a channel." */
  summary: ReactNode;
  children: ReactNode;
}) {
  if (!connected) return <>{children}</>;
  return (
    <>
      <StatusLine tone="done">{summary}</StatusLine>
      <CollapsibleSection title="Edit settings">
        <div className="space-y-4 pt-3">{children}</div>
      </CollapsibleSection>
    </>
  );
}
