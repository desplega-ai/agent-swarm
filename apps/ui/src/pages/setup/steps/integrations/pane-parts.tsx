import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import type { ConfigForm } from "./use-config-form";

/** Inline external link in helper copy. */
export function ExternalTextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
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

/** Primary save button for a pane, with a hint while a required field is empty. */
export function SaveRow({
  form,
  label,
  missingHint,
}: {
  form: ConfigForm;
  label: string;
  missingHint: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        onClick={() => void form.save()}
        disabled={!form.dirty || !form.requiredMet || form.saving}
      >
        {form.saving ? <Loader2 className="size-4 animate-spin" /> : null}
        {label}
      </Button>
      {form.requiredMet ? null : (
        <span className="text-xs text-muted-foreground">{missingHint}</span>
      )}
    </div>
  );
}

/** Connected: a success row, with the form folded under "Edit settings". */
export function ConnectedGate({
  connected,
  title,
  detail,
  children,
}: {
  connected: boolean;
  title: string;
  detail?: ReactNode;
  children: ReactNode;
}) {
  if (!connected) return <>{children}</>;
  return (
    <>
      <AlertCallout tone="success" icon={CheckCircle2} title={detail ? title : undefined}>
        {detail ?? title}
      </AlertCallout>
      <CollapsibleSection title="Edit settings">
        <div className="space-y-4 pt-3">{children}</div>
      </CollapsibleSection>
    </>
  );
}
