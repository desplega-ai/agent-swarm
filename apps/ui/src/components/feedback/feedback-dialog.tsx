import { ExternalLink, X } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useSubmitFeedback } from "@/api/hooks/use-feedback";
import {
  isUiTelemetryEnabled,
  type PopupDismissMethod,
  useUiTelemetry,
} from "@/api/hooks/use-ui-telemetry";
import type { FeedbackInput } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { promptShownThisLoad, useOtherDialogOpen } from "@/hooks/use-other-dialog-open";
import {
  type FeedbackPopupState,
  type FeedbackTrigger,
  feedbackPopupStorageKey,
  feedbackPopupTrigger,
  followUpQuestion,
  parseFeedbackPopupState,
} from "@/lib/feedback-popup";
import { cn } from "@/lib/utils";

const CALENDAR_URL = "https://calendar.app.google/R1ngNwcjs4vrJDk96";
const DEFAULT_FEEDBACK_ENDPOINT = "https://proxy.desplega.sh/v1/feedback";
const FEEDBACK_ENDPOINT_CONFIG_KEY = "feedback_endpoint";
const SESSION_ID_KEY = "swarm:feedback-popup:session:v1";
const SCORES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

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

/**
 * One-tap 0-10 feedback card for self-hosted admins. A tap on a score sends it
 * right away; a follow-up question and contact details are optional and update
 * the same submission (the proxy keeps the latest row per `submission_id`).
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
  const feedbackEndpoint = configValue(FEEDBACK_ENDPOINT_CONFIG_KEY) ?? DEFAULT_FEEDBACK_ENDPOINT;
  const telemetryOn = isUiTelemetryEnabled(status.data);
  const installId = configValue("telemetry_installation_id");
  const installedAt = configValue("telemetry_installed_at");
  const instance = status.data?.instance;
  const orgName = status.data?.identity.name ?? "";
  const submitFeedback = useSubmitFeedback(feedbackEndpoint);
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
  const [score, setScore] = useState<number | null>(null);
  const [sendingScore, setSendingScore] = useState<number | null>(null);
  // Read from request callbacks, which outlive the render that started them.
  const activeRef = useRef(active);
  activeRef.current = active;
  const popupStateRef = useRef(popupState);
  popupStateRef.current = popupState;
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [includeOrgName, setIncludeOrgName] = useState(false);
  const [followUpSent, setFollowUpSent] = useState(false);
  const submittedReported = useRef(false);

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
    setMessage("");
    setName("");
    setEmail("");
    setNewsletterConsent(false);
    setIncludeOrgName(false);
    setFollowUpSent(false);
    submittedReported.current = false;
    savePopupState({ lastShownAt: new Date().toISOString() });
    sendEvent({ event: "popup.shown", properties: { popup: "feedback", trigger } });
  }, [trigger]);

  function buildInput(nps: number, extra: Partial<FeedbackInput> = {}): FeedbackInput | null {
    if (!currentUser.userId || !active) return null;
    return {
      submission_id: active.submissionId,
      user_id: currentUser.userId,
      // Telemetry off: no install ID, and the org name only when the user opts in.
      ...(telemetryOn && installId ? { install_id: installId, installed_at: installedAt } : {}),
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
      properties: {
        popup: "feedback",
        score,
        has_message: followUpSent && message.trim().length > 0,
        has_contact: followUpSent && Boolean(name.trim() || email.trim()),
      },
    });
  }

  function close(method: PopupDismissMethod) {
    if (sendingScore !== null) {
      // The in-flight score reports itself when it lands; nothing to dismiss.
    } else if (score === null) {
      sendEvent({ event: "popup.dismissed", properties: { popup: "feedback", method } });
      savePopupState({ lastDismissedAt: new Date().toISOString() });
    } else {
      reportSubmitted();
    }
    setActive(null);
  }

  // `score` is the delivered score: it is set, and the 90-day suppression saved,
  // only once the proxy accepts it. A failed send keeps the card and its
  // submission ID, so a second tap retries the same submission.
  function pickScore(value: number) {
    if (score !== null || sendingScore !== null) return;
    const input = buildInput(value);
    if (!input) return;
    const submissionId = input.submission_id;
    setSendingScore(value);
    submitFeedback.mutate(input, {
      onSuccess: () => {
        setSendingScore(null);
        savePopupState({
          lastSubmittedAt: new Date().toISOString(),
          submissionCount: popupStateRef.current.submissionCount + 1,
        });
        if (activeRef.current?.submissionId === submissionId) {
          setScore(value);
        } else {
          // Closed while the score was in flight: the score still landed.
          sendEvent({
            event: "popup.submitted",
            properties: { popup: "feedback", score: value, has_message: false, has_contact: false },
          });
        }
      },
      onError: () => {
        setSendingScore(null);
        toast.error("Could not send your score. Please try again.");
      },
    });
  }

  function handleFollowUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (score === null) return;
    const input = buildInput(score, {
      message: message.trim() || undefined,
      name: name.trim() || undefined,
      email: email.trim() || undefined,
      newsletter_consent: newsletterConsent,
    });
    if (!input) return;
    submitFeedback.mutate(input, {
      onSuccess: () => {
        setFollowUpSent(true);
        toast.success("Thanks for sharing your feedback.");
      },
      onError: () => toast.error("Could not send feedback. Please try again."),
    });
  }

  // `followUpSent` flips after the follow-up lands; report the final flags then.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the follow-up lands
  useEffect(() => {
    if (!followUpSent) return;
    reportSubmitted();
    setActive(null);
  }, [followUpSent]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close("escape");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!active) return null;

  const canSendFollowUp =
    score !== null &&
    !submitFeedback.isPending &&
    Boolean(message.trim() || name.trim() || email.trim() || includeOrgName);

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="feedback-card-title"
      data-feedback-popup
      className="fixed right-4 bottom-4 z-50 w-[calc(100vw-2rem)] max-w-md space-y-4 rounded-lg border bg-background p-5 shadow-lg"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="feedback-card-title" className="text-sm font-medium leading-snug">
          How likely are you to recommend Agent Swarm to a friend or colleague?
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={() => close("close")}
          className="rounded-xs text-muted-foreground opacity-70 transition-opacity hover:opacity-100"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="sr-only">Score from 0 to 10</legend>
        <div className="grid grid-cols-11 gap-1">
          {SCORES.map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={(score ?? sendingScore) === value ? "default" : "outline"}
              aria-pressed={(score ?? sendingScore) === value}
              aria-label={`${value} out of 10`}
              disabled={sendingScore !== null || (score !== null && score !== value)}
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
        <form className="space-y-3" onSubmit={handleFollowUp}>
          <p className="text-xs text-muted-foreground">Thanks, your score is in. Anything else?</p>
          <div className="space-y-1.5">
            <Label htmlFor="feedback-message">{followUpQuestion(score)}</Label>
            <Textarea
              id="feedback-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={10_000}
              rows={3}
            />
          </div>
          <details className="space-y-2 text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Leave your contact (optional)
            </summary>
            <div className="grid gap-2 pt-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="feedback-name">Name</Label>
                <Input
                  id="feedback-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={200}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="feedback-email">Email</Label>
                <Input
                  id="feedback-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  maxLength={320}
                />
              </div>
            </div>
            <label className="flex items-start gap-2 pt-1 text-xs leading-relaxed">
              <input
                type="checkbox"
                checked={newsletterConsent}
                onChange={(event) => setNewsletterConsent(event.target.checked)}
                className="mt-0.5 size-4 rounded border-input accent-primary"
              />
              <span>Desplega may email me, including the newsletter</span>
            </label>
            {!telemetryOn && orgName ? (
              <label className="flex items-start gap-2 text-xs leading-relaxed">
                <input
                  type="checkbox"
                  checked={includeOrgName}
                  onChange={(event) => setIncludeOrgName(event.target.checked)}
                  className="mt-0.5 size-4 rounded border-input accent-primary"
                />
                <span>Include my organization name</span>
              </label>
            ) : null}
          </details>
          <div className="flex items-center justify-between gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={CALENDAR_URL} target="_blank" rel="noreferrer">
                Book a call
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => close("close")}>
                Done
              </Button>
              <Button type="submit" size="sm" disabled={!canSendFollowUp}>
                {submitFeedback.isPending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        </form>
      )}
    </section>
  );
}
