import { ExternalLink, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useCompanyProfile } from "@/api/hooks/use-company-profile";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useSubmitFeedback } from "@/api/hooks/use-feedback";
import {
  isUiTelemetryEnabled,
  type OrgProfileField,
  type PopupDismissMethod,
  useUiTelemetry,
} from "@/api/hooks/use-ui-telemetry";
import type { ApprovalQuestion, FeedbackInput } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { BorderBeam } from "@/components/shared/border-beam";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { SetupChip } from "@/components/shared/setup-chip";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { promptShownThisLoad, useOtherDialogOpen } from "@/hooks/use-other-dialog-open";
import {
  ACQUISITION_SOURCES,
  type AcquisitionSource,
  optionLabel,
  optionValue,
  type ProfileOption,
  TEAM_SIZES,
  type TeamSize,
  USE_CASES,
  type UseCase,
} from "@/lib/company-profile";
import {
  FEEDBACK_TRIGGER_LINES,
  type FeedbackPopupState,
  type FeedbackTrigger,
  feedbackPopupStorageKey,
  feedbackPopupTrigger,
  followUpQuestion,
  parseFeedbackPopupState,
} from "@/lib/feedback-popup";
import { isAdminLike } from "@/lib/user-role";
import { cn } from "@/lib/utils";

const CALENDAR_URL = "https://calendar.app.google/R1ngNwcjs4vrJDk96";
const SESSION_ID_KEY = "swarm:feedback-popup:session:v1";
const SCORES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * The proxy refuses a body over 8 KB, so the free-text answer stays well under
 * it. Counted in UTF-8 bytes: an emoji or an accented letter takes more than one.
 */
const MESSAGE_MAX_BYTES = 6000;

/** The one-tap profile questions, in order. A question the swarm already stores is skipped. */
const PROFILE_QUESTIONS = [
  { id: "use_case", label: "What does your swarm mostly do?", options: USE_CASES },
  { id: "team_size", label: "How many people work with this swarm?", options: TEAM_SIZES },
  { id: "acquisition_source", label: "How did you hear about us?", options: ACQUISITION_SOURCES },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  options: readonly ProfileOption[];
}>;
type ProfileQuestionId = (typeof PROFILE_QUESTIONS)[number]["id"];

/** What the follow-up Submit sends, beyond the score. */
interface FollowUpAnswers {
  message?: string;
  use_case?: UseCase;
  team_size?: TeamSize;
  acquisition_source?: AcquisitionSource;
  /** Set only when "Reply to me" is checked. */
  contact?: { name?: string; email: string; newsletterConsent: boolean };
  /** How many profile questions have an answer (`has_message` covers the message). */
  answered: number;
}

/** A per-tab browser session ID, so `task_failed` can wait for a later session. */
function browserSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_ID_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID();
    sessionStorage.setItem(SESSION_ID_KEY, minted);
    return minted;
  } catch {
    return "no-session-storage";
  }
}

/** A native checkbox row, unchecked by default like every consent here. */
function CheckboxRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-xs leading-relaxed">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 rounded border-input accent-primary"
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * One-tap 0-10 feedback card for self-hosted admins. A tap on a score sends it
 * right away. Until the follow-up is submitted, another tap re-sends the same
 * submission with the new score (the proxy keeps the latest row per
 * `submission_id`). The follow-up asks up to three one-tap profile questions,
 * then one text question, then an optional "Reply to me".
 */
export function FeedbackDialog() {
  const status = useStatusContext();
  const currentUser = useCurrentUser();
  const { config } = useConfig();
  const { data: globalConfigs } = useConfigs({ scope: "global" });
  const otherDialogOpen = useOtherDialogOpen();
  const sendEvent = useUiTelemetry();
  const configValue = (key: string) =>
    globalConfigs?.find((entry) => entry.key === key)?.value.trim() || null;
  const telemetryOn = isUiTelemetryEnabled(status.data);
  const installedAt = configValue("telemetry_installed_at");
  const instance = status.data?.instance;
  const orgName = status.data?.identity.name ?? "";
  const submitFeedback = useSubmitFeedback();
  const [sessionId] = useState(browserSessionId);
  const storageKey = useMemo(
    () => feedbackPopupStorageKey(config.apiUrl, currentUser.userId ?? "pending"),
    [config.apiUrl, currentUser.userId],
  );
  const [popupState, setPopupState] = useState<FeedbackPopupState>(() => {
    try {
      return parseFeedbackPopupState(localStorage.getItem(storageKey));
    } catch {
      return parseFeedbackPopupState(null);
    }
  });
  const [loadedStorageKey, setLoadedStorageKey] = useState(storageKey);
  // Pinned when the card opens, so the card stays up while state changes under it.
  const [active, setActive] = useState<{ submissionId: string; trigger: FeedbackTrigger } | null>(
    null,
  );
  // The delivered score: set only once the proxy accepts it.
  const [score, setScore] = useState<number | null>(null);
  const [sendingScore, setSendingScore] = useState<number | null>(null);
  // Read from request callbacks, which outlive the render that started them.
  const activeRef = useRef(active);
  activeRef.current = active;
  const popupStateRef = useRef(popupState);
  popupStateRef.current = popupState;
  const sendingScoreRef = useRef(sendingScore);
  sendingScoreRef.current = sendingScore;
  const [includeOrgName, setIncludeOrgName] = useState(false);
  // "sending" locks the grid, so a late score cannot replace the follow-up row.
  const [followUp, setFollowUp] = useState<"open" | "sending" | "sent">("open");
  const followUpReport = useRef<{ has_message: boolean; has_contact: boolean; answered: number }>({
    has_message: false,
    has_contact: false,
    answered: 0,
  });
  const submittedReported = useRef(false);
  // A close while the follow-up is sending waits for the send, so the answers are not dropped.
  const closeAfterSend = useRef(false);

  const ready =
    status.data !== null &&
    status.data !== undefined &&
    globalConfigs !== undefined &&
    loadedStorageKey === storageKey;
  const trigger =
    ready && !active && !promptShownThisLoad(config.apiUrl)
      ? feedbackPopupTrigger({
          isCloud: status.data?.identity.is_cloud === true,
          currentUserState: currentUser.state,
          user: currentUser.user,
          state: popupState,
          installedAt: installedAt ?? instance?.first_seen_at ?? null,
          tasksCompleted: instance?.tasks_completed ?? 0,
          tasksFailed: instance?.tasks_failed ?? 0,
          workflowRunsCompleted: instance?.workflow_runs_completed ?? 0,
          sessionId,
          otherDialogOpen,
        })
      : null;

  useEffect(() => {
    try {
      setPopupState(parseFeedbackPopupState(localStorage.getItem(storageKey)));
    } catch {
      setPopupState(parseFeedbackPopupState(null));
    }
    setLoadedStorageKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === storageKey) setPopupState(parseFeedbackPopupState(event.newValue));
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey]);

  /** Merge `patch` into the latest state, so two writes in one commit do not drop each other. */
  function savePopupState(patch: Partial<FeedbackPopupState>) {
    setPopupState((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage can be unavailable in privacy mode; in-memory state still suppresses this session.
      }
      return next;
    });
    setLoadedStorageKey(storageKey);
  }

  // Remember the session that first saw a failed task: `task_failed` waits for a later one.
  const tasksFailed = instance?.tasks_failed ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: savePopupState is recreated each render; the guard stops a second write
  useEffect(() => {
    if (!ready || tasksFailed === 0 || popupState.firstFailureSessionId !== null) return;
    savePopupState({
      firstFailureSessionId: sessionId,
      firstFailureSeenAt: new Date().toISOString(),
    });
  }, [ready, tasksFailed, popupState, sessionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: open once per trigger; the other values are read at that moment
  useEffect(() => {
    if (!trigger) return;
    setActive({ submissionId: crypto.randomUUID(), trigger });
    // A fresh card: nothing carries over from an earlier one in this mount.
    setScore(null);
    setSendingScore(null);
    setIncludeOrgName(false);
    setFollowUp("open");
    followUpReport.current = { has_message: false, has_contact: false, answered: 0 };
    submittedReported.current = false;
    closeAfterSend.current = false;
    savePopupState({ lastShownAt: new Date().toISOString() });
    sendEvent({ event: "popup.shown", properties: { popup: "feedback", trigger } });
  }, [trigger]);

  function buildInput(nps: number, extra: Partial<FeedbackInput> = {}): FeedbackInput | null {
    if (!currentUser.userId || !active) return null;
    return {
      submission_id: active.submissionId,
      user_id: currentUser.userId,
      // Telemetry off: the org name only when the user opts in. `useSubmitFeedback`
      // adds the install ID, and only while telemetry is on.
      ...(telemetryOn || includeOrgName ? { org_name: orgName } : {}),
      swarm_version: __APP_VERSION__,
      newsletter_consent: false,
      nps,
      scale: "0-10",
      submitted_at: new Date().toISOString(),
      ...extra,
    };
  }

  function reportSubmitted() {
    if (submittedReported.current || score === null) return;
    submittedReported.current = true;
    sendEvent({
      event: "popup.submitted",
      properties: { popup: "feedback", score, ...followUpReport.current },
    });
  }

  function close(method: PopupDismissMethod) {
    if (followUp === "sending") {
      closeAfterSend.current = true;
      return;
    }
    if (sendingScore !== null && score === null) {
      // The in-flight first score reports itself when it lands; nothing to dismiss.
    } else if (score === null) {
      sendEvent({ event: "popup.dismissed", properties: { popup: "feedback", method } });
      savePopupState({ lastDismissedAt: new Date().toISOString() });
    } else {
      reportSubmitted();
    }
    setActive(null);
  }

  // A failed send keeps the card, its submission ID and the last delivered
  // score, so another tap retries the same submission. The 90-day suppression
  // starts with the first delivered score.
  function pickScore(value: number) {
    if (followUp !== "open" || sendingScore !== null || value === score) return;
    const input = buildInput(value);
    if (!input) return;
    const submissionId = input.submission_id;
    const first = score === null;
    setSendingScore(value);
    submitFeedback.mutate(input, {
      onSuccess: () => {
        setSendingScore(null);
        if (first) {
          savePopupState({
            lastSubmittedAt: new Date().toISOString(),
            submissionCount: popupStateRef.current.submissionCount + 1,
          });
        }
        if (activeRef.current?.submissionId === submissionId) {
          setScore(value);
        } else if (first) {
          // Closed while the score was in flight: the score still landed.
          sendEvent({
            event: "popup.submitted",
            properties: {
              popup: "feedback",
              score: value,
              has_message: false,
              has_contact: false,
              answered: 0,
            },
          });
        }
      },
      onError: () => {
        setSendingScore(null);
        toast.error(
          first
            ? "Could not send your score. Please try again."
            : "Could not change your score. Please try again.",
        );
      },
    });
  }

  async function sendFollowUp(answers: FollowUpAnswers) {
    if (score === null) throw new Error("Pick a score first.");
    if (sendingScoreRef.current !== null) throw new Error("Wait for your new score to send.");
    const { contact } = answers;
    const input = buildInput(score, {
      message: answers.message,
      use_case: answers.use_case,
      team_size: answers.team_size,
      acquisition_source: answers.acquisition_source,
      ...(contact
        ? {
            name: contact.name,
            email: contact.email,
            newsletter_consent: contact.newsletterConsent,
          }
        : {}),
    });
    if (!input) throw new Error("Could not send. Try again.");
    setFollowUp("sending");
    try {
      await submitFeedback.mutateAsync(input);
    } catch {
      // The card stays open, so the error and the answers stay in view.
      closeAfterSend.current = false;
      setFollowUp("open");
      throw new Error("Could not send your answers. Try again.");
    }
    followUpReport.current = {
      has_message: Boolean(answers.message),
      has_contact: Boolean(contact),
      answered: answers.answered,
    };
    setFollowUp("sent");
    // The effect below reports the submission with these flags.
    if (closeAfterSend.current) setActive(null);
  }

  // Report the final flags once the follow-up lands. The card stays open on its done view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the follow-up lands
  useEffect(() => {
    if (followUp === "sent") reportSubmitted();
  }, [followUp]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape in a field leaves the field first (QuestionFlow handles it).
      const { target } = event;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) return;
      close("escape");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!active) return null;

  const shownScore = sendingScore ?? score;

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="feedback-card-title"
      data-feedback-popup
      className="fixed right-4 bottom-4 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md flex-col rounded-lg border bg-background shadow-lg"
    >
      <BorderBeam className={cn("rounded-lg", shownScore !== null && "opacity-0")} />
      {/* The body scrolls, so the beam on the border is never clipped. */}
      <div className="min-h-0 space-y-4 overflow-y-auto p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {FEEDBACK_TRIGGER_LINES[active.trigger]}
            </p>
            <h2 id="feedback-card-title" className="text-sm font-medium leading-snug">
              How likely are you to recommend Agent Swarm to a friend or colleague?
            </h2>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Close"
            onClick={() => close("close")}
          >
            <X aria-hidden="true" />
          </Button>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="sr-only">Score from 0 to 10</legend>
          <div className="grid grid-cols-11 gap-1">
            {SCORES.map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={shownScore === value ? "default" : "outline"}
                aria-pressed={shownScore === value}
                aria-label={`${value} out of 10`}
                disabled={sendingScore !== null || (followUp !== "open" && score !== value)}
                onClick={() => pickScore(value)}
                className={cn("h-8 px-0 tabular-nums", score === value && "shadow-sm")}
              >
                {value}
              </Button>
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Not likely</span>
            <span>Very likely</span>
          </div>
        </fieldset>

        {score === null ? (
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => close("later")}>
              Not now
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {followUp === "sent" ? null : sendingScore !== null ? (
              <StatusLine tone="busy" className="text-xs text-muted-foreground">
                Updating your score…
              </StatusLine>
            ) : (
              <StatusLine tone="success" className="text-xs text-muted-foreground">
                Your score is in. Tap another number to change it.
              </StatusLine>
            )}
            <FeedbackFollowUp
              score={shownScore ?? score}
              showOrgNameOptIn={!telemetryOn && Boolean(orgName)}
              includeOrgName={includeOrgName}
              onIncludeOrgName={setIncludeOrgName}
              onSend={sendFollowUp}
            />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The follow-up on the shared QuestionFlow. Admins also store the profile
 * answers in the swarm (surface `feedback`), so no surface asks them again.
 * Non-admins send them in the feedback only.
 */
function FeedbackFollowUp({
  score,
  showOrgNameOptIn,
  includeOrgName,
  onIncludeOrgName,
  onSend,
}: {
  score: number;
  showOrgNameOptIn: boolean;
  includeOrgName: boolean;
  onIncludeOrgName: (include: boolean) => void;
  onSend: (answers: FollowUpAnswers) => Promise<void>;
}) {
  const currentUser = useCurrentUser();
  const profile = useCompanyProfile();
  const canSave = isAdminLike(currentUser.user);
  // Pinned on mount: a later config poll does not add or drop a card mid-flow.
  const [asked] = useState(() =>
    PROFILE_QUESTIONS.filter((question) => {
      const stored = {
        use_case: profile.useCase,
        team_size: profile.teamSize,
        acquisition_source: profile.acquisitionSource,
      }[question.id];
      return stored === null;
    }),
  );
  const [reply, setReply] = useState(false);
  const [name, setName] = useState(currentUser.user?.name ?? "");
  const [email, setEmail] = useState(currentUser.user?.email ?? "");
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [saved, setSaved] = useState<OrgProfileField[]>([]);

  const questions: ApprovalQuestion[] = [
    ...asked.map(
      (question): ApprovalQuestion => ({
        id: question.id,
        type: "single-select",
        label: question.label,
        options: [...question.options],
      }),
    ),
    {
      id: "message",
      type: "text",
      multiline: true,
      label: followUpQuestion(score),
      description: `Keep it under about ${MESSAGE_MAX_BYTES.toLocaleString("en-US")} characters.`,
    },
  ];

  async function submit(values: QuestionFlowValues) {
    const message = typeof values.message === "string" ? values.message.trim() : "";
    if (new TextEncoder().encode(message).length > MESSAGE_MAX_BYTES) {
      // Short, so the submit bar shows it whole.
      throw new Error("Too long to send. Shorten it.");
    }
    const picked = <V extends string>(
      id: ProfileQuestionId,
      options: readonly ProfileOption<V>[],
    ) => (asked.some((question) => question.id === id) ? optionValue(options, values[id]) : null);
    const useCase = picked("use_case", USE_CASES);
    const teamSize = picked("team_size", TEAM_SIZES);
    const acquisitionSource = picked("acquisition_source", ACQUISITION_SOURCES);
    const contactEmail = email.trim();
    if (reply && !EMAIL_PATTERN.test(contactEmail)) {
      throw new Error("Enter a valid email, so we can reply.");
    }
    await onSend({
      message: message || undefined,
      use_case: useCase ?? undefined,
      team_size: teamSize ?? undefined,
      acquisition_source: acquisitionSource ?? undefined,
      contact: reply
        ? { name: name.trim() || undefined, email: contactEmail, newsletterConsent }
        : undefined,
      answered: [useCase, teamSize, acquisitionSource].filter(Boolean).length,
    });
    if (!canSave || !(useCase || teamSize || acquisitionSource)) return;
    try {
      setSaved(
        await profile.save(
          {
            useCase: useCase ?? undefined,
            teamSize: teamSize ?? undefined,
            acquisitionSource: acquisitionSource ?? undefined,
          },
          "feedback",
        ),
      );
    } catch {
      toast.error("Sent. Could not save the answers to your swarm profile.");
    }
  }

  const note =
    asked.length === 0
      ? "Submit sends your answer to Desplega with your score."
      : canSave
        ? "One tap each. Submit sends these answers to Desplega with your score and saves them in your swarm, so we never ask the same question twice."
        : "One tap each. Submit sends these answers to Desplega with your score.";

  return (
    <QuestionFlow
      foldAnswered
      questions={questions}
      onSubmit={submit}
      footer={
        <div className="space-y-2 rounded-lg border bg-surface p-3">
          <p className="text-xs text-muted-foreground">{note}</p>
          {showOrgNameOptIn ? (
            <CheckboxRow checked={includeOrgName} onChange={onIncludeOrgName}>
              Include my organization name
            </CheckboxRow>
          ) : null}
          <CheckboxRow checked={reply} onChange={setReply}>
            Reply to me
            <span className="block text-muted-foreground">
              Sends your name and email to Desplega with these answers.
            </span>
          </CheckboxRow>
          <AnimatedReveal open={reply}>
            <div className="space-y-2 pt-1">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="feedback-name">Name</Label>
                  <Input
                    id="feedback-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={200}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="feedback-email">Work email</Label>
                  <Input
                    id="feedback-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    maxLength={320}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <CheckboxRow checked={newsletterConsent} onChange={setNewsletterConsent}>
                Desplega may email me, including the newsletter
              </CheckboxRow>
            </div>
          </AnimatedReveal>
          <Button asChild variant="outline" size="sm">
            <a href={CALENDAR_URL} target="_blank" rel="noreferrer">
              Book a call
              <ExternalLink aria-hidden="true" />
            </a>
          </Button>
        </div>
      }
      done={(values) => (
        <div className="space-y-2">
          <StatusLine tone="success">
            {saved.length > 0
              ? "Sent. Saved to your swarm profile:"
              : reply
                ? `Sent. Expect a reply at ${email.trim()}.`
                : "Sent. The team reads every answer."}
          </StatusLine>
          {saved.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {asked.map((question) =>
                saved.includes(question.id) ? (
                  <SetupChip key={question.id} tone="done">
                    {optionLabel(question.options, values[question.id])}
                  </SetupChip>
                ) : null,
              )}
            </div>
          ) : null}
        </div>
      )}
    />
  );
}
