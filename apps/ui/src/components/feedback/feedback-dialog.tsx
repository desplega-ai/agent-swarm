import { ExternalLink } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useSubmitFeedback } from "@/api/hooks/use-feedback";
import { useTasks } from "@/api/hooks/use-tasks";
import { useStatusContext } from "@/app/status-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { useOtherDialogOpen } from "@/hooks/use-other-dialog-open";
import {
  type FeedbackPopupState,
  feedbackPopupStorageKey,
  parseFeedbackPopupState,
  shouldShowFeedbackPopup,
} from "@/lib/feedback-popup";
import { cn } from "@/lib/utils";

const CALENDAR_URL = "https://calendar.app.google/R1ngNwcjs4vrJDk96";
const DEFAULT_FEEDBACK_ENDPOINT = "https://proxy.desplega.sh/v1/feedback";
const FEEDBACK_ENDPOINT_CONFIG_KEY = "feedback_endpoint";

export function FeedbackDialog() {
  const status = useStatusContext();
  const currentUser = useCurrentUser();
  const { config } = useConfig();
  const { data: globalConfigs } = useConfigs({ scope: "global" });
  const failedTasks = useTasks({ status: "failed", limit: 1 });
  const otherDialogOpen = useOtherDialogOpen();
  const configValue = (key: string) =>
    globalConfigs?.find((entry) => entry.key === key)?.value.trim() || null;
  const feedbackEndpoint = configValue(FEEDBACK_ENDPOINT_CONFIG_KEY) ?? DEFAULT_FEEDBACK_ENDPOINT;
  const installId = configValue("telemetry_installation_id");
  const installedAt = configValue("telemetry_installed_at");
  const orgName = status.data?.identity.name ?? "";
  const submitFeedback = useSubmitFeedback(feedbackEndpoint);
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
  const [attempt, setAttempt] = useState<{
    submissionId: string;
    submittedAt: string;
  } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [nps, setNps] = useState<1 | 2 | 3 | 4 | 5>();
  const [message, setMessage] = useState("");

  const open =
    status.data !== null &&
    status.data !== undefined &&
    globalConfigs !== undefined &&
    loadedStorageKey === storageKey &&
    shouldShowFeedbackPopup({
      isCloud: status.data?.identity.is_cloud === true,
      currentUserState: currentUser.state,
      user: currentUser.user,
      state: popupState,
      installedAt,
      hasFailedTask: (failedTasks.data?.total ?? 0) > 0,
      otherDialogOpen,
    });

  useEffect(() => {
    try {
      setPopupState(parseFeedbackPopupState(localStorage.getItem(storageKey)));
    } catch {
      setPopupState(parseFeedbackPopupState(null));
    }
    setLoadedStorageKey(storageKey);
  }, [storageKey]);

  useEffect(() => {
    if (open && !attempt) {
      setAttempt({ submissionId: crypto.randomUUID(), submittedAt: new Date().toISOString() });
    }
  }, [attempt, open]);

  useEffect(() => {
    const handler = (event: StorageEvent) => {
      if (event.key === storageKey) setPopupState(parseFeedbackPopupState(event.newValue));
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [storageKey]);

  function savePopupState(next: FeedbackPopupState) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Storage can be unavailable in privacy mode; in-memory state still suppresses this session.
    }
    setPopupState(next);
    setLoadedStorageKey(storageKey);
  }

  function dismiss() {
    savePopupState({ ...popupState, lastDismissedAt: new Date().toISOString() });
    setAttempt(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentUser.userId || !attempt) return;
    submitFeedback.mutate(
      {
        submission_id: attempt.submissionId,
        user_id: currentUser.userId,
        install_id: installId,
        installed_at: installedAt,
        org_name: orgName,
        swarm_version: __APP_VERSION__,
        name: name || undefined,
        email: email || undefined,
        newsletter_consent: newsletterConsent,
        nps,
        message: message || undefined,
        submitted_at: attempt.submittedAt,
      },
      {
        onSuccess: () => {
          savePopupState({
            ...popupState,
            lastSubmittedAt: new Date().toISOString(),
            submissionCount: popupState.submissionCount + 1,
          });
          setAttempt(null);
          toast.success("Thanks for sharing your feedback.");
        },
        onError: () => {
          toast.error("Could not send feedback. Please try again.");
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent
        data-feedback-popup
        className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="pr-6 leading-snug">
            We are eager to hear your thoughts, do you have a minute for us?
          </DialogTitle>
          <DialogDescription>
            Everything is optional. Share as much or as little as you like.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="feedback-name">Name</Label>
              <Input
                id="feedback-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
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

          <label className="flex items-start gap-2 text-sm leading-relaxed">
            <input
              type="checkbox"
              checked={newsletterConsent}
              onChange={(event) => setNewsletterConsent(event.target.checked)}
              className="mt-0.5 size-4 rounded border-input accent-primary"
            />
            <span>Desplega may email me, including the newsletter</span>
          </label>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              How likely are you to recommend Agent Swarm?
            </legend>
            <div className="flex gap-2">
              {([1, 2, 3, 4, 5] as const).map((rating) => (
                <Button
                  key={rating}
                  type="button"
                  variant={nps === rating ? "default" : "outline"}
                  size="icon"
                  aria-pressed={nps === rating}
                  aria-label={`Rate ${rating} out of 5`}
                  onClick={() => setNps(rating)}
                  className={cn("rounded-full", nps === rating && "shadow-sm")}
                >
                  {rating}
                </Button>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="feedback-message">Message</Label>
            <Textarea
              id="feedback-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={10_000}
              rows={4}
            />
          </div>

          <DialogFooter className="sm:justify-between">
            <Button asChild variant="outline">
              <a href={CALENDAR_URL} target="_blank" rel="noreferrer">
                Book a call with us
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
            <Button type="submit" disabled={submitFeedback.isPending || !attempt}>
              {submitFeedback.isPending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
