import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type { ApprovalQuestion, ApprovalRequest } from "@/api/types";
import { FadeIn } from "@/components/shared/fade-in";
import {
  KeyHint,
  useFinePointer,
  useKeyboardShortcuts,
} from "@/components/shared/questions/keyboard";
import { QuestionCard } from "@/components/shared/questions/question-card";
import { optionValues, QuestionField } from "@/components/shared/questions/question-field";
import { SubmitBar } from "@/components/shared/questions/submit-bar";
import type { StatusTone } from "@/components/shared/status-icon";
import { answerHint, answerProgress, isAnswered } from "@/lib/approval-format";
import { type DetailShortcut, matchDetailShortcut } from "@/lib/approval-shortcuts";

export type QuestionFlowValues = Record<string, unknown>;

/** SubmitBar hides Discard for any request that is not pending. */
const NO_DISCARD: Pick<ApprovalRequest, "status" | "workflowRunId"> = {
  status: "approved",
  workflowRunId: null,
};

function keyHintFor(question: ApprovalQuestion) {
  if (question.type === "multi-select") return "1–9 · Space";
  if (question.type === "text") return "↵ to type";
  return null;
}

/**
 * The Approvals answer flow (`pages/approval-requests/[id]/page.tsx`) for
 * short in-product forms: the QuestionCard + QuestionField stack, the amber
 * beam on the first open question, J/K/1-9/Enter keys, the SubmitBar with its
 * ticking counter, and a fade swap to `done` once `onSubmit` resolves.
 *
 * Keys listen only while the pointer or focus is inside the flow, because
 * several flows can be mounted at once.
 */
export function QuestionFlow({
  questions,
  initialValues = {},
  footer,
  done,
  onSubmit,
  onChange,
  foldAnswered,
}: {
  questions: ApprovalQuestion[];
  /** Pre-filled answers (for example a website from the email domain). Read on mount. */
  initialValues?: QuestionFlowValues;
  /** Shown under the cards, above the submit bar (consent copy, a perk). */
  footer?: ReactNode;
  /** The view after a successful submit. */
  done?: (values: QuestionFlowValues) => ReactNode;
  /**
   * Sends the answers. The submit bar spins while it is pending. A rejection
   * shows its message in the submit bar and keeps the answers.
   */
  onSubmit: (values: QuestionFlowValues) => Promise<void>;
  /** Every answer change before submit (not called for `initialValues`). */
  onChange?: (values: QuestionFlowValues) => void;
  /** Fold answered cards to one line. Approvals does this above 5 questions. */
  foldAnswered?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const finePointer = useFinePointer();
  const [responses, setResponses] = useState<QuestionFlowValues>(initialValues);
  const [attempted, setAttempted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({});
  const [cursors, setCursors] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const compact = foldAnswered ?? questions.length > 5;
  const progress = useMemo(() => answerProgress(questions, responses), [questions, responses]);
  const firstOpenIndex = useMemo(
    () => questions.findIndex((question) => !isAnswered(question, responses[question.id])),
    [questions, responses],
  );
  const targetIndex = activeIndex >= 0 ? activeIndex : Math.max(firstOpenIndex, 0);

  const focusCard = useCallback(
    (index: number) => {
      const card = cards.current[index];
      setActiveIndex(index);
      if (!card) return;
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
    },
    [reduceMotion],
  );

  const isCollapsed = (question: ApprovalQuestion, index: number): boolean | null => {
    if (!compact || !isAnswered(question, responses[question.id])) return null;
    return collapsedOverride[question.id] ?? index !== activeIndex;
  };

  const handleSubmit = async () => {
    if (submitting || submitted) return;
    if (progress.blockedReason) {
      setAttempted(true);
      const firstBlocked = questions.findIndex((question) =>
        Boolean(answerHint(question, responses[question.id])),
      );
      if (firstBlocked >= 0) focusCard(firstBlocked);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(responses);
      setSubmitted(true);
      setActiveIndex(-1);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not send. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const update = (next: QuestionFlowValues) => {
    setResponses(next);
    setError(null);
    onChange?.(next);
  };

  const answer = (index: number, value: unknown, advance: boolean) => {
    const next = { ...responses, [questions[index].id]: value };
    update(next);
    if (!advance) return;
    const after = questions.findIndex((q, i) => i > index && !isAnswered(q, next[q.id]));
    if (after >= 0) focusCard(after);
  };

  const toggleOption = (question: ApprovalQuestion, value: string) => {
    const selected = Array.isArray(responses[question.id])
      ? (responses[question.id] as string[])
      : [];
    update({
      ...responses,
      [question.id]: selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    });
  };

  const onShortcut = (action: DetailShortcut): boolean | undefined => {
    const n = questions.length;
    const question = questions[targetIndex];
    switch (action.type) {
      case "next":
        focusCard(activeIndex < 0 ? targetIndex : Math.min(activeIndex + 1, n - 1));
        return;
      case "prev":
        focusCard(activeIndex < 0 ? targetIndex : Math.max(activeIndex - 1, 0));
        return;
      case "help":
      case "back":
        return false;
      case "leave-field": {
        const card = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
          "[data-question-index]",
        );
        (document.activeElement as HTMLElement | null)?.blur();
        card?.focus({ preventScroll: true });
        return;
      }
      case "submit":
        void handleSubmit();
        return;
      case "expand": {
        if (!question) return false;
        const collapsed = isCollapsed(question, targetIndex);
        if (collapsed === null) return false;
        setCollapsedOverride((prev) => ({ ...prev, [question.id]: !collapsed }));
        return;
      }
    }
    if (submitting || !question) return false;
    const values = optionValues(question);
    switch (action.type) {
      case "approve":
      case "reject":
        if (question.type !== "approval") return false;
        answer(targetIndex, { approved: action.type === "approve" }, true);
        return;
      case "pick": {
        const value = values[action.index];
        if (value === undefined) return false;
        if (question.type === "boolean") answer(targetIndex, value === "yes", true);
        else if (question.type === "single-select") answer(targetIndex, value, true);
        else if (question.type === "multi-select") {
          toggleOption(question, value);
          setCursors((prev) => ({ ...prev, [question.id]: action.index }));
          setActiveIndex(targetIndex);
        } else return false;
        return;
      }
      case "cursor": {
        if (question.type !== "multi-select" || values.length === 0) return false;
        const current = cursors[question.id] ?? -1;
        const next = (current + action.delta + values.length) % values.length;
        setCursors((prev) => ({ ...prev, [question.id]: next }));
        setActiveIndex(targetIndex);
        return;
      }
      case "toggle": {
        if (question.type !== "multi-select" || values.length === 0) return false;
        const cursor = Math.max(cursors[question.id] ?? 0, 0);
        toggleOption(question, values[cursor]);
        setCursors((prev) => ({ ...prev, [question.id]: cursor }));
        setActiveIndex(targetIndex);
        return;
      }
      case "edit": {
        if (question.type !== "text" && question.type !== "config") return false;
        cards.current[targetIndex]?.querySelector<HTMLElement>("input, textarea")?.focus();
        setActiveIndex(targetIndex);
        return;
      }
    }
    return false;
  };

  // The flow's own dialog or popover (the identity modal, the bell) does not block its keys.
  useKeyboardShortcuts(
    matchDetailShortcut,
    onShortcut,
    !submitted && (hovered || focusWithin),
    rootRef,
  );

  const cardsList = questions.map((question, index) => {
    const response = responses[question.id];
    const collapsed = isCollapsed(question, index);
    const focused = index === activeIndex;
    const showKeys = finePointer && index === targetIndex;
    const answered = isAnswered(question, response);
    const hint = question.id in responses || attempted ? answerHint(question, response) : null;
    const tone: StatusTone = answered ? "done" : hint ? "error" : "dirty";
    const label = answered
      ? "Answered"
      : (hint ?? (question.required ? "Needs an answer" : "Optional"));
    const hintText = showKeys ? keyHintFor(question) : null;
    return (
      <QuestionCard
        key={question.id}
        ref={(el) => {
          cards.current[index] = el;
        }}
        question={question}
        index={index}
        statusTone={tone}
        statusLabel={label}
        focused={focused}
        beam={!submitting && index === firstOpenIndex}
        collapsed={collapsed}
        onToggleCollapsed={() =>
          setCollapsedOverride((prev) => ({ ...prev, [question.id]: !collapsed }))
        }
        answer={response}
        hint={hint}
        keyHint={hintText ? <KeyHint className="px-1.5">{hintText}</KeyHint> : null}
        onActivate={() => setActiveIndex(index)}
      >
        <QuestionField
          question={question}
          value={response}
          onChange={(value) => answer(index, value, false)}
          disabled={submitting}
          cursor={focused ? (cursors[question.id] ?? -1) : -1}
          showKeys={showKeys}
          onSubmitShortcut={handleSubmit}
        />
      </QuestionCard>
    );
  });

  return (
    <div
      ref={rootRef}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusWithin(false);
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={submitted ? "done" : "answering"}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          className="flex flex-col"
        >
          {submitted ? (
            <FadeIn className="flex flex-col gap-3">{done?.(responses)}</FadeIn>
          ) : (
            <>
              <FadeIn className="flex flex-col gap-3">
                {cardsList}
                {footer}
              </FadeIn>
              <SubmitBar
                request={NO_DISCARD}
                progress={progress}
                submitting={submitting}
                discarding={false}
                error={error}
                onSubmit={handleSubmit}
                onDiscard={() => {}}
              />
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
