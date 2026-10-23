import { ChevronRight } from "lucide-react";
import type { PromptDisplay } from "@/lib/prompt-display";
import { cn } from "@/lib/utils";

/**
 * What `parsePromptDisplay` took off a task prompt, shown above the ask:
 * markers as small label/value pairs, then each wrapper block as a collapsed
 * quoted section (thread context first). Renders nothing for a plain prompt.
 */
export function PromptContext({
  display,
  className,
}: {
  display: Pick<PromptDisplay, "meta" | "sections">;
  className?: string;
}) {
  if (display.meta.length === 0 && display.sections.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 whitespace-normal", className)}>
      {display.meta.length > 0 ? (
        <dl className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-meta text-muted-foreground">
          {display.meta.map((m) => (
            <div key={`${m.label}:${m.value}`} className="flex min-w-0 gap-1">
              <dt className="shrink-0 font-mono uppercase tracking-wider">{m.label}</dt>
              <dd className="min-w-0 truncate" title={m.value}>
                {m.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {display.sections.map((section, index) => (
        <details
          // Sections have no id, and their order never changes for one prompt.
          // biome-ignore lint/suspicious/noArrayIndexKey: stable order per prompt
          key={`${section.tag}-${index}`}
          open={section.defaultOpen}
          className="group/prompt-section min-w-0 text-muted-foreground"
        >
          <summary className="flex cursor-pointer list-none items-center gap-1 text-meta font-mono uppercase tracking-wider select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-open/prompt-section:rotate-90" />
            {section.label}
            {section.messages ? ` (${section.messages.length})` : null}
          </summary>
          <blockquote className="mt-1 ml-1.5 min-w-0 border-l-2 border-border pl-2.5 text-sm leading-relaxed">
            {section.messages ? (
              <ul className="flex flex-col gap-1">
                {section.messages.map((m, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: thread order is fixed
                  <li key={i} className="whitespace-pre-wrap wrap-anywhere">
                    <span className="font-medium text-foreground/80">
                      {m.speaker ?? "Someone"}:
                    </span>{" "}
                    {m.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="whitespace-pre-wrap wrap-anywhere">{section.text}</p>
            )}
          </blockquote>
        </details>
      ))}
    </div>
  );
}
