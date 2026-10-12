/**
 * "Your swarm vs. similar swarms" on Home, with the Slack Connect perk.
 *
 * The API compares this swarm's last 30 days with the fleet percentiles the
 * telemetry proxy publishes (only with telemetry on and an org name set). The
 * perk is the bell's Slack Connect invite in a compact form: submitting or
 * dismissing it here resolves the same inbox row. It also shows alone once a
 * workflow has completed, until the invite is resolved.
 */
import { MessagesSquare, Users, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useFleetBenchmark } from "@/api/hooks/use-fleet-benchmark";
import { useInboxState } from "@/api/hooks/use-inbox-state";
import { useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import type { FleetBenchmarkResponse } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import {
  fleetCardMode,
  fleetPlacement,
  formatFleetMedian,
  formatFleetValue,
} from "@/lib/fleet-benchmark";
import {
  SLACK_CONNECT_INVITE_KEY,
  useSlackConnectInvite,
} from "../notifications/use-slack-connect-invite";

/** One `fleet_benchmark.viewed` per page load, however often Home re-mounts. */
let viewedThisLoad = false;

export function FleetBenchmarkCard() {
  const currentUser = useCurrentUser();
  const { data: status } = useStatusContext();
  const benchmark = useFleetBenchmark(Boolean(status));
  const benchmarkCard = useDismissibleCard("fleet-benchmark");
  const inbox = useInboxState({ userId: currentUser.userId, itemType: "notification" });
  const track = useUiTelemetry();

  const invite = inbox.data?.find((row) => row.itemId === SLACK_CONNECT_INVITE_KEY);
  const inviteOpen =
    Boolean(currentUser.userId) &&
    inbox.isSuccess &&
    invite?.status !== "dismissed" &&
    invite?.status !== "done";
  const mode = fleetCardMode({
    benchmark: benchmark.data,
    benchmarkDismissed: benchmarkCard.dismissed,
    inviteOpen,
    workflowRunsCompleted: status?.instance?.workflow_runs_completed ?? 0,
  });

  const shown = mode === "benchmark" || mode === "progress";
  useEffect(() => {
    if (!shown || viewedThisLoad) return;
    viewedThisLoad = true;
    // The card only renders with an org name set; the property keeps the
    // catalog's shape for a later hint state.
    track({ event: "fleet_benchmark.viewed", properties: { has_org_name: true } });
  }, [shown, track]);

  if (!mode) return null;
  if (mode === "perk") {
    return (
      <section
        aria-label="Slack Connect"
        className="w-full rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5"
      >
        <SlackPerk />
      </section>
    );
  }

  const data = benchmark.data as FleetBenchmarkResponse;
  return (
    <section
      aria-label="Your swarm vs. similar swarms"
      className="w-full rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Users className="size-3.5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium leading-snug">Your swarm vs. similar swarms</p>
          {mode === "benchmark" ? (
            <ul className="space-y-0.5 text-sm text-muted-foreground">
              {data.comparisons.map((comparison) => (
                <li key={comparison.key}>
                  <span className="font-medium text-foreground">
                    {formatFleetValue(comparison)}
                  </span>
                  , {fleetPlacement(comparison)}{" "}
                  <span className="text-xs">(median {formatFleetMedian(comparison)})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Finish {data.minFinishedTasks} tasks in 30 days to compare (
              {data.local?.finishedTasks ?? 0} so far).
            </p>
          )}
          {inviteOpen ? (
            <div className="border-t border-border/60 pt-2">
              <SlackPerk />
            </div>
          ) : null}
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={benchmarkCard.dismiss}
          aria-label="Dismiss the fleet benchmark"
          title="Dismiss"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}

function SlackPerk() {
  const invite = useSlackConnectInvite();
  const [email, setEmail] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    invite.submit(email);
  }

  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-center"
      onSubmit={handleSubmit}
      aria-label="Ask for a shared Slack channel"
    >
      <p className="flex min-w-0 flex-1 items-start gap-1.5 text-sm text-muted-foreground">
        <MessagesSquare className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          <span className="font-medium text-foreground">Slack Connect:</span> a shared channel with
          the team that builds it. We reply within a business day.
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Input
          type="email"
          required
          placeholder="you@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-8 w-48 text-sm"
          aria-label="Your email"
        />
        <Button type="submit" size="sm" disabled={!email.trim()}>
          Ask
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={invite.dismiss}>
          No thanks
        </Button>
      </div>
    </form>
  );
}
