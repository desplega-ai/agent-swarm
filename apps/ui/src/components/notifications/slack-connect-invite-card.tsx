import { type FormEvent, useState } from "react";
import type { InboxItemState } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { NotificationDefinition } from "@/lib/notifications/definitions";
import { useSlackConnectInvite } from "./use-slack-connect-invite";

export function SlackConnectInviteCard({
  definition,
  state,
}: {
  definition: NotificationDefinition;
  state?: InboxItemState;
}) {
  const invite = useSlackConnectInvite(definition.key);
  const [email, setEmail] = useState("");

  const resolved = state?.status === "dismissed" || state?.status === "done";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invite.submit(email);
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
          <Button type="button" variant="ghost" size="sm" onClick={invite.dismiss}>
            Dismiss
          </Button>
        </form>
      ) : null}
    </div>
  );
}
