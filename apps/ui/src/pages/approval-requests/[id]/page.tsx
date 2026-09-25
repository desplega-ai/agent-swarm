import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useApprovalRequest, useRespondToApprovalRequest } from "@/api/hooks/use-approval-requests";
import type { ApprovalQuestion, ApprovalRequest } from "@/api/types";
import { FadeIn } from "@/components/onboarding/fade-in";
import type { StatusTone } from "@/components/shared/status-icon";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
  Relationship,
  Relationships,
} from "@/components/ui/detail-page-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  answerHint,
  answerProgress,
  formatApprovalAnswer,
  humanizeSeconds,
  isAnswered,
} from "@/lib/approval-format";
import { type DetailShortcut, matchDetailShortcut } from "@/lib/approval-shortcuts";
import { formatSmartTime } from "@/lib/utils";
import { AnswerView } from "../components/answer-view";
import {
  KeyHint,
  ShortcutSheet,
  useFinePointer,
  useKeyboardShortcuts,
  useMediaQuery,
} from "../components/keyboard";
import { QuestionCard } from "../components/question-card";
import { optionValues, QuestionField } from "../components/question-field";
import { RequestHeader } from "../components/request-header";
import { SubmitBar } from "../components/submit-bar";

/** Above this many questions, answered cards fold to one line. */
const COMPACT_AFTER = 5;

const RESOLVED_TONE: Record<string, StatusTone> = {
  success: "success",
  error: "error",
  neutral: "saved",
  empty: "none",
};

function keyHintFor(question: ApprovalQuestion) {
  switch (question.type) {
    // Approve/Reject, Yes/No and options carry their own keycaps.
    case "multi-select":
      return "1–9 · Space";
    case "text":
      return "↵ to type";
    default:
      return null;
  }
}

export default function ApprovalRequestDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { data: request, isLoading } = useApprovalRequest(id);

  if (isLoading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-36 rounded-xl" />
        <Skeleton className="h-36 rounded-xl" />
      </div>
    );
  }

  if (!request) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-muted-foreground">
        Approval request not found
      </div>
    );
  }

  // Keyed by id: a different request starts with a clean draft.
  return <ApprovalRequestView key={request.id} request={request} />;
}

function ApprovalRequestView({ request }: { request: ApprovalRequest }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const respondMutation = useRespondToApprovalRequest();
  const { user } = useCurrentUser();
  const reduceMotion = useReducedMotion();
  const finePointer = useFinePointer();
  const desktop = useMediaQuery("(min-width: 1024px)");

  const [responses, setResponses] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({});
  const [cursors, setCursors] = useState<Record<string, number>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const cards = useRef<(HTMLElement | null)[]>([]);
  const top = useRef<HTMLDivElement>(null);

  const questions = request.questions;
  const isPending = request.status === "pending";
  const compact = questions.length > COMPACT_AFTER;
  const submitting = respondMutation.isPending;
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
    if (isPending) {
      if (!compact || !isAnswered(question, responses[question.id])) return null;
      return collapsedOverride[question.id] ?? index !== activeIndex;
    }
    if (!question.description) return null;
    return collapsedOverride[question.id] ?? true;
  };

  const handleSubmit = async () => {
    if (!isPending || submitting) return;
    if (progress.blockedReason) {
      setAttempted(true);
      const firstBlocked = questions.findIndex((question) =>
        Boolean(answerHint(question, responses[question.id])),
      );
      if (firstBlocked >= 0) focusCard(firstBlocked);
      return;
    }
    setError(null);
    try {
      const result = await respondMutation.mutateAsync({
        id: request.id,
        responses,
        // Attribute the answer to the picked identity ("Approved by …").
        respondedBy: user?.email ?? user?.name ?? undefined,
      });
      // Swap to the resolved view in place from the response: no refetch flash.
      queryClient.setQueryData(["approval-request", request.id], result);
      setActiveIndex(-1);
      top.current?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit response");
    }
  };

  /** Answer and, from the keyboard, move on to the next open question. */
  const answer = (index: number, value: unknown, advance: boolean) => {
    const question = questions[index];
    const next = { ...responses, [question.id]: value };
    setResponses(next);
    setError(null);
    if (!advance) return;
    const after = questions.findIndex((q, i) => i > index && !isAnswered(q, next[q.id]));
    if (after >= 0) focusCard(after);
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
        setSheetOpen(true);
        return;
      case "back":
        void navigate("/approval-requests");
        return;
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
    if (!isPending || submitting || !question) return false;
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
        if (question.type !== "text") return false;
        cards.current[targetIndex]?.querySelector<HTMLElement>("input, textarea")?.focus();
        setActiveIndex(targetIndex);
        return;
      }
    }
    return false;
  };

  const toggleOption = (question: ApprovalQuestion, value: string) => {
    setResponses((prev) => {
      const selected = Array.isArray(prev[question.id]) ? (prev[question.id] as string[]) : [];
      return {
        ...prev,
        [question.id]: selected.includes(value)
          ? selected.filter((v) => v !== value)
          : [...selected, value],
      };
    });
  };

  useKeyboardShortcuts(matchDetailShortcut, onShortcut);

  const cardsList = questions.map((question, index) => {
    const response = isPending ? responses[question.id] : request.responses?.[question.id];
    const collapsed = isCollapsed(question, index);
    const focused = index === activeIndex;
    const showKeys = finePointer && isPending && index === targetIndex;
    let tone: StatusTone;
    let label: string;
    let hint: string | null = null;
    if (isPending) {
      const answered = isAnswered(question, response);
      const touched = question.id in responses;
      hint = touched || attempted ? answerHint(question, response) : null;
      tone = answered ? "done" : hint ? "error" : "dirty";
      label = answered
        ? "Answered"
        : hint
          ? hint
          : question.required
            ? "Needs an answer"
            : "Optional";
    } else {
      const formatted = formatApprovalAnswer(question, response);
      tone = RESOLVED_TONE[formatted.tone] ?? "saved";
      label = formatted.text;
    }
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
        beam={isPending && !submitting && index === firstOpenIndex}
        collapsed={collapsed}
        onToggleCollapsed={() =>
          setCollapsedOverride((prev) => ({ ...prev, [question.id]: !collapsed }))
        }
        answer={response}
        hint={hint}
        keyHint={hintText ? <KeyHint className="px-1.5">{hintText}</KeyHint> : null}
        onActivate={() => setActiveIndex(index)}
      >
        {isPending ? (
          <QuestionField
            question={question}
            value={response}
            onChange={(value) => answer(index, value, false)}
            disabled={submitting}
            cursor={focused ? (cursors[question.id] ?? -1) : -1}
            showKeys={showKeys}
            onSubmitShortcut={handleSubmit}
          />
        ) : collapsed === null || collapsed === false ? (
          <AnswerView question={question} response={response} />
        ) : null}
      </QuestionCard>
    );
  });

  const main = (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={isPending ? "pending" : "resolved"}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        className="flex flex-col"
      >
        <FadeIn className="flex flex-col gap-3">
          {compact && isPending ? (
            <p className="text-xs text-muted-foreground">
              {questions.length} questions · answered ones fold away
              {finePointer ? (
                <>
                  {" "}
                  · <KeyHint>J</KeyHint> <KeyHint>K</KeyHint> to move
                </>
              ) : null}
            </p>
          ) : null}
          {cardsList}
          {!isPending && request.responses ? (
            <details className="group rounded-lg border border-border-subtle px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
                Raw responses
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                {JSON.stringify(request.responses, null, 2)}
              </pre>
            </details>
          ) : null}
        </FadeIn>
        {/* Room for the fixed phone bar under the last card. */}
        {isPending ? <div aria-hidden className="h-28 md:hidden" /> : null}
        {isPending ? (
          <SubmitBar
            progress={progress}
            submitting={submitting}
            error={error}
            onSubmit={() => void handleSubmit()}
          />
        ) : null}
      </motion.div>
    </AnimatePresence>
  );

  const rail = desktop ? (
    <DetailPageRail>
      <QuickStats>
        <QuickStat label="Created" value={formatSmartTime(request.createdAt)} />
        {request.resolvedAt ? (
          <QuickStat label="Resolved" value={formatSmartTime(request.resolvedAt)} />
        ) : null}
        {request.resolvedBy ? <QuickStat label="Resolved by" value={request.resolvedBy} /> : null}
        {request.timeoutSeconds ? (
          <QuickStat label="Timeout" value={humanizeSeconds(request.timeoutSeconds)} />
        ) : null}
        <QuickStat label="Questions" value={questions.length} />
      </QuickStats>
      {request.workflowRunId || request.sourceTaskId ? (
        <Relationships>
          {request.workflowRunId ? (
            <Relationship label="Workflow run" to={`/workflow-runs/${request.workflowRunId}`} />
          ) : null}
          {request.sourceTaskId ? (
            <Relationship label="Source task" to={`/tasks/${request.sourceTaskId}`} />
          ) : null}
        </Relationships>
      ) : null}
    </DetailPageRail>
  ) : undefined;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
      <div ref={top} className="flex scroll-mt-4 flex-col gap-5">
        <RequestHeader
          request={request}
          showKeys={finePointer}
          onOpenShortcuts={() => setSheetOpen(true)}
        />
        <DetailPageBody main={main} rail={rail} />
      </div>
      <ShortcutSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}
