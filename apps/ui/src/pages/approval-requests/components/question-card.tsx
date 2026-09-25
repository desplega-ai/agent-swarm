import { ChevronDown } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { ApprovalQuestion } from "@/api/types";
import { SetupChip } from "@/components/onboarding/setup-card";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { BorderBeam } from "@/components/shared/border-beam";
import { StatusIcon, type StatusTone } from "@/components/shared/status-icon";
import { selectionRange } from "@/lib/approval-format";
import { cn, normalizeNewlines } from "@/lib/utils";
import { AnswerView, WRAP } from "./answer-view";

/**
 * One question, in the #1604 SetupCard anatomy (index slot, title, one-line
 * meta, status icon on the right), built here rather than on SetupCard
 * because the title is markdown that may hold links: a collapsible SetupCard
 * puts the title inside a <button>, and a link inside a button is invalid.
 *
 * - `focused`: the keyboard cursor (amber outline + ring).
 * - `beam`: the first question still waiting on you (amber border beam).
 * - `collapsed`: an answered card folds to its header plus the answer.
 */
export const QuestionCard = forwardRef<
  HTMLElement,
  {
    question: ApprovalQuestion;
    index: number;
    statusTone: StatusTone;
    statusLabel: string;
    focused: boolean;
    beam: boolean;
    /** Null: not collapsible. */
    collapsed: boolean | null;
    onToggleCollapsed: () => void;
    /** The answer to show in the header while collapsed. */
    answer: unknown;
    hint: string | null;
    keyHint?: ReactNode;
    onActivate: () => void;
    children?: ReactNode;
  }
>(function QuestionCard(
  {
    question,
    index,
    statusTone,
    statusLabel,
    focused,
    beam,
    collapsed,
    onToggleCollapsed,
    answer,
    hint,
    keyHint,
    onActivate,
    children,
  },
  ref,
) {
  const titleId = `q-${question.id}-title`;
  const open = collapsed !== true;
  const range = question.type === "multi-select" ? selectionRange(question) : null;
  const body = (
    <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-[3.25rem]">
      {question.description ? (
        <div className={cn("prose-chat max-w-prose text-sm text-muted-foreground", WRAP)}>
          <Streamdown>{normalizeNewlines(question.description)}</Streamdown>
        </div>
      ) : null}
      {children}
      {hint ? <p className="text-xs text-status-error-strong">{hint}</p> : null}
    </div>
  );

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      data-question-index={index}
      onFocusCapture={onActivate}
      onPointerDown={onActivate}
      className={cn(
        "relative scroll-mt-4 scroll-mb-28 rounded-xl border bg-card shadow-sm outline-none",
        "transition-[border-color,box-shadow] duration-200 ease-snappy",
        focused ? "border-primary/60 ring-2 ring-primary/20" : "border-border",
      )}
    >
      {beam ? <BorderBeam /> : null}
      <div className="flex items-start gap-3 px-4 py-3">
        <span
          aria-hidden
          className={cn(
            "mt-px flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] tabular-nums transition-colors",
            focused
              ? "border-primary/60 bg-primary/10 text-foreground"
              : "border-border text-muted-foreground",
          )}
        >
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div id={titleId} className={cn("text-sm font-semibold leading-snug [&_p]:my-0", WRAP)}>
            <Streamdown>{normalizeNewlines(question.label)}</Streamdown>
          </div>
          {!question.required || range || keyHint ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {!question.required ? <SetupChip>Optional</SetupChip> : null}
              {range ? <SetupChip>{range}</SetupChip> : null}
              {keyHint}
            </div>
          ) : null}
          {collapsed ? <AnswerView question={question} response={answer} compact /> : null}
        </div>
        <span className="mt-1 flex shrink-0 items-center gap-1">
          <StatusIcon tone={statusTone} label={statusLabel} />
          {collapsed !== null ? (
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-expanded={open}
              aria-controls={`q-${question.id}-body`}
              aria-keyshortcuts="O"
              aria-label={open ? "Collapse" : "Expand"}
              className="-m-2 ml-0 flex size-10 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 sm:size-8 sm:-m-1"
            >
              <ChevronDown
                className={cn(
                  "size-4 transition-transform duration-150 ease-snappy",
                  open && "rotate-180",
                )}
              />
            </button>
          ) : null}
        </span>
      </div>
      <div id={`q-${question.id}-body`}>
        {/* Always the same tree: a card that becomes collapsible on its first
            answer must not remount its field (it would drop focus mid-typing). */}
        <AnimatedReveal open={open}>{body}</AnimatedReveal>
      </div>
    </section>
  );
});
