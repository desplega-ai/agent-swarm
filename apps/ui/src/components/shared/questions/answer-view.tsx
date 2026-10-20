import { CircleCheck, CircleX } from "lucide-react";
import type { ApprovalQuestion } from "@/api/types";
import { type FormattedAnswer, formatApprovalAnswer } from "@/lib/approval-format";
import { cn } from "@/lib/utils";

/** Wrap anything a person or an agent typed: long URLs must never clip. */
/** Streamdown renders links as inline-block buttons, so they need `anywhere` too. */
export const WRAP = "min-w-0 wrap-anywhere [&_button]:max-w-full [&_button]:wrap-anywhere";

/** A picked option, in reading size (chips at 9px are for status, not answers). */
function AnswerPill({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        muted
          ? "border-border text-muted-foreground"
          : "border-primary/30 bg-primary/5 text-foreground",
        WRAP,
      )}
    >
      {children}
    </span>
  );
}

function Decision({ answer, compact }: { answer: FormattedAnswer; compact?: boolean }) {
  if (answer.tone === "neutral") {
    return (
      <span className="flex min-w-0">
        <AnswerPill>{answer.text}</AnswerPill>
      </span>
    );
  }
  const Icon = answer.tone === "error" ? CircleX : CircleCheck;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-sm font-medium",
          answer.tone === "success" && "text-status-success-strong",
          answer.tone === "error" && "text-status-error-strong",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        {answer.text}
      </span>
      {answer.note ? (
        <span
          className={cn(
            "text-sm text-muted-foreground whitespace-pre-wrap",
            WRAP,
            compact && "line-clamp-1",
          )}
        >
          {answer.note}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A submitted (or draft) answer in words: a decision with its tone, the
 * picked option labels as chips, or the typed text. `compact` keeps it to
 * one line for a collapsed card header.
 */
export function AnswerView({
  question,
  response,
  compact = false,
  className,
}: {
  question: ApprovalQuestion;
  response: unknown;
  compact?: boolean;
  className?: string;
}) {
  const answer = formatApprovalAnswer(question, response);
  let body: React.ReactNode;
  switch (answer.kind) {
    case "decision":
      body = <Decision answer={answer} compact={compact} />;
      break;
    case "choice":
      body = (
        <span className="flex min-w-0">
          <AnswerPill>{answer.text}</AnswerPill>
        </span>
      );
      break;
    case "choices":
      body = (
        <span className="flex min-w-0 flex-wrap gap-1">
          {(compact ? answer.items?.slice(0, 3) : answer.items)?.map((item) => (
            <AnswerPill key={item}>{item}</AnswerPill>
          ))}
          {compact && (answer.items?.length ?? 0) > 3 ? (
            <AnswerPill muted>+{(answer.items?.length ?? 0) - 3}</AnswerPill>
          ) : null}
        </span>
      );
      break;
    case "text":
      body = (
        <span
          className={cn(
            "block text-sm text-foreground whitespace-pre-wrap",
            WRAP,
            compact && "line-clamp-1",
          )}
        >
          {answer.text}
        </span>
      );
      break;
    case "raw":
      body = (
        <code
          className={cn(
            "block font-mono text-xs text-muted-foreground break-all",
            compact && "line-clamp-1",
          )}
        >
          {answer.text}
        </code>
      );
      break;
    default:
      body = <span className="text-sm text-muted-foreground italic">{answer.text}</span>;
  }
  return <div className={cn("min-w-0", className)}>{body}</div>;
}
