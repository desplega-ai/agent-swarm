import { Quote } from "lucide-react";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Badge } from "@/components/ui/badge";
import {
  citationDropReason,
  citationHttpUrl,
  citedIndices,
  type TaskCitation,
} from "../../../../../src/utils/task-citations";

type CitationState =
  | { tone: "cited"; label: string }
  | { tone: "general"; label: string }
  | { tone: "warning"; label: string; reason: string }
  | { tone: "error"; label: string; reason: string };

function citationState(citation: TaskCitation, used: Set<number>): CitationState {
  const dropReason = citationDropReason(citation);
  if (dropReason) return { tone: "error", label: "dropped", reason: dropReason };
  if (used.has(citation.index)) return { tone: "cited", label: "cited inline" };
  if (citation.general) return { tone: "general", label: "general" };
  return {
    tone: "warning",
    label: "not referenced",
    reason: "No [citation:N] marker in the output; shown under General sources.",
  };
}

const TONE_CLASS: Record<CitationState["tone"], string> = {
  cited: "border-status-success/30 text-status-success-strong",
  general: "text-muted-foreground",
  warning: "border-status-warning/30 text-status-warning-strong",
  error: "border-status-error/30 text-status-error-strong",
};

/**
 * Every citation the agent stored, including ones dropped from the rendered
 * output, with the reason, so a human can see what the agent intended.
 */
export function TaskCitationsSection({
  output,
  citations,
}: {
  output: string;
  citations: readonly TaskCitation[];
}) {
  const used = citedIndices(output);
  const missing = [...used].filter((index) => !citations.some((entry) => entry.index === index));
  if (!citations.length && !missing.length) return null;
  const rows = [...citations].sort((a, b) => a.index - b.index);

  return (
    <CollapsibleSection
      variant="card"
      title={`Citations (${citations.length})`}
      icon={Quote}
      iconColor="text-muted-foreground"
      borderColor="border-border"
      bgColor="bg-muted/20"
      defaultOpen
    >
      <ul className="space-y-2 text-sm">
        {rows.map((citation) => {
          const state = citationState(citation, used);
          const href = citation.resolvedUrl ? citationHttpUrl(citation.resolvedUrl) : null;
          return (
            <li key={citation.index} className="flex flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">[{citation.index}]</span>
                <Badge variant="outline" size="tag" className="text-muted-foreground">
                  {citation.kind}
                </Badge>
                <Badge variant="outline" size="tag" className={TONE_CLASS[state.tone]}>
                  {state.label}
                </Badge>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {citation.label || citation.ref}
                  </a>
                ) : (
                  <span>{citation.label || citation.ref}</span>
                )}
              </div>
              <div className="pl-7 font-mono text-xs text-muted-foreground break-all">
                {citation.ref}
              </div>
              {"reason" in state && (
                <div className="pl-7 text-xs text-muted-foreground">{state.reason}</div>
              )}
            </li>
          );
        })}
        {missing.map((index) => (
          <li key={`missing-${index}`} className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">[{index}]</span>
            <Badge variant="outline" size="tag" className={TONE_CLASS.error}>
              no entry
            </Badge>
            <span className="text-xs text-muted-foreground">
              [citation:{index}] is in the output but has no citation entry; the marker is removed.
            </span>
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}
