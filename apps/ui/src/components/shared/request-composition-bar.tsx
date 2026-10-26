import { createContext, useContext } from "react";
import { formatTokens } from "@/lib/format-tokens";
import {
  type CallComposition,
  COMPOSITION_GROUPS,
  type CompositionGroup,
} from "@/lib/request-composition";
import { cn } from "@/lib/utils";

export const NO_CALL_COMPOSITIONS: ReadonlyMap<string, CallComposition> = new Map();

/**
 * Each LLM call's composition, by `CallUsage.callId`, for the session log's
 * cache chips. Empty: the chips show no bar.
 */
export const CallCompositionContext = createContext(NO_CALL_COMPOSITIONS);

export function useCallComposition(callId: string): CallComposition | undefined {
  return useContext(CallCompositionContext).get(callId);
}

export const COMPOSITION_SWATCH: Record<CompositionGroup, string> = {
  system: "bg-chart-1",
  persona: "bg-chart-2",
  tools: "bg-chart-3",
  skills: "bg-chart-4",
  task: "bg-chart-5",
  harness: "bg-status-neutral",
  history: "bg-muted-foreground/35",
};

const GROUP_LABEL = new Map(COMPOSITION_GROUPS.map((g) => [g.group, g.label]));

/** Tokens, with "est." when the number is an estimate (never chars). */
export function compositionTokens(tokens: number, estimate: boolean): string {
  const text = formatTokens(Math.round(tokens));
  return estimate ? `${text} est.` : text;
}

/** One call's prompt as a stacked bar, with a token legend. */
export function CallCompositionBar({ composition }: { composition: CallComposition }) {
  const { promptTokens, segments, scaled, manifest } = composition;
  return (
    <div className="space-y-2" data-testid="call-composition">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-sans text-xs font-medium">Prompt composition</span>
        <span className="text-muted-foreground" data-testid="call-composition-prompt">
          {formatTokens(promptTokens)} tokens
        </span>
      </div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={segments
          .map((s) => `${GROUP_LABEL.get(s.group)} ${compositionTokens(s.tokens, s.estimate)}`)
          .join(", ")}
      >
        {segments.map((s) => (
          <span
            key={s.group}
            className={cn("h-full", COMPOSITION_SWATCH[s.group])}
            style={{ width: `${(s.tokens / promptTokens) * 100}%` }}
          />
        ))}
      </div>
      <ul className="space-y-0.5">
        {segments.map((s) => (
          <li
            key={s.group}
            className="flex items-center gap-2"
            data-testid="call-composition-segment"
            data-group={s.group}
            data-tokens={s.tokens}
          >
            <span className={cn("size-2 shrink-0 rounded-sm", COMPOSITION_SWATCH[s.group])} />
            <span className="min-w-0 flex-1 truncate font-sans">{GROUP_LABEL.get(s.group)}</span>
            <span>{compositionTokens(s.tokens, s.estimate)}</span>
            <span className="w-9 text-right text-muted-foreground">
              {Math.round((s.tokens / promptTokens) * 100)}%
            </span>
          </li>
        ))}
      </ul>
      <p className="font-sans text-muted-foreground">
        {scaled
          ? "The estimates exceed this call's prompt, so they are scaled down to fit."
          : manifest.source === "harness-hook"
            ? "Parts measured from the request the harness sent."
            : "Harness base: the first call minus our parts. History: the rest."}
      </p>
    </div>
  );
}
