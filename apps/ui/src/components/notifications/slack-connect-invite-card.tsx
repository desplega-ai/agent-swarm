import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useUpdateInboxItem } from "@/api/hooks/use-inbox-state";
import { useNotificationEvents } from "@/api/hooks/use-notification-events";
import type { InboxItemState } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { NotificationDefinition } from "@/lib/notifications/definitions";

export function SlackConnectInviteCard({
  definition,
  state,
}: {
  definition: NotificationDefinition;
  state?: InboxItemState;
}) {
  const currentUser = useCurrentUser();
  const updateInboxItem = useUpdateInboxItem();
  const { trackEvent, notifyUs } = useNotificationEvents();
  const [email, setEmail] = useState("");

  const resolved = state?.status === "dismissed" || state?.status === "done";

  function resolve(status: "dismissed" | "done") {
    if (!currentUser.userId) return;
    updateInboxItem.mutate({
      userId: currentUser.userId,
      itemType: "notification",
      itemId: definition.key,
      status,
    });
  }

  function handleDismiss() {
    trackEvent(definition.key, "dismiss");
    resolve("dismissed");
  }

  function handleAlreadyHaveOne() {
    trackEvent(definition.key, "already_have_one");
    resolve("done");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim();
    if (!value) return;
    const domain = value.split("@")[1] || undefined;
    notifyUs(definition.key, "requested a Slack Connect channel invite", value);
    trackEvent(definition.key, "submit", domain);
    resolve("done");
    toast.success("Thanks — we'll reach out to set up the Slack Connect channel.");
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-snug">{definition.title}</p>
        {resolved ? (
          <Badge variant="secondary" className="shrink-0">
            {state?.status === "dismissed" ? "Dismissed" : "Done"}
          </Badge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{definition.body}</p>

      {!resolved ? (
        <form className="space-y-2 pt-1" onSubmit={handleSubmit}>
          <div className="flex gap-2">
            <Input
              type="email"
              required
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-8 text-sm"
              aria-label="Your email"
            />
            <Button type="submit" size="sm" disabled={!email.trim()}>
              OK
            </Button>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={handleDismiss}>
              Dismiss
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleAlreadyHaveOne}>
              I already have one
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
