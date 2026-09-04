import { ExternalLink } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
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
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import { useOtherDialogOpen } from "@/hooks/use-other-dialog-open";
import { shouldShowFeedbackPopup } from "@/lib/feedback-popup";
import { cn } from "@/lib/utils";

const CALENDAR_URL = "https://calendar.app.google/R1ngNwcjs4vrJDk96";

export function FeedbackDialog() {
  const status = useStatusContext();
  const currentUser = useCurrentUser();
  const failedTasks = useTasks({ status: "failed", limit: 1 });
  const card = useDismissibleCard(`feedback-popup:${currentUser.userId ?? "pending"}`);
  const otherDialogOpen = useOtherDialogOpen();
  const submitFeedback = useSubmitFeedback();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [newsletterConsent, setNewsletterConsent] = useState(false);
  const [nps, setNps] = useState<1 | 2 | 3 | 4 | 5>();
  const [message, setMessage] = useState("");

  const apiSupportsFeedback =
    status.data !== null &&
    status.data !== undefined &&
    Object.hasOwn(status.data.identity, "installed_at");
  const open =
    apiSupportsFeedback &&
    shouldShowFeedbackPopup({
      isCloud: status.data?.identity.is_cloud === true,
      currentUserState: currentUser.state,
      user: currentUser.user,
      dismissed: card.dismissed,
      installedAt: status.data?.identity.installed_at ?? null,
      hasFailedTask: (failedTasks.data?.total ?? 0) > 0,
      otherDialogOpen,
    });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentUser.userId) return;
    submitFeedback.mutate(
      {
        name: name || undefined,
        email: email || undefined,
        newsletter_consent: newsletterConsent,
        nps,
        message: message || undefined,
        user_id: currentUser.userId,
      },
      {
        onSuccess: () => {
          card.dismiss();
          toast.success("Thanks for sharing your feedback.");
        },
        onError: () => toast.error("Could not send feedback. Please try again."),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) card.dismiss();
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
            <Button type="submit" disabled={submitFeedback.isPending}>
              {submitFeedback.isPending ? "Sending…" : "Send"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
