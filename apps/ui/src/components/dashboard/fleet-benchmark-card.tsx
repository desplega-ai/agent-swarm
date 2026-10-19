/**
 * "Your swarm vs. similar swarms" on Home, with the Slack Connect perk.
 *
 * The API compares this swarm's last 30 days with the fleet percentiles the
 * telemetry proxy publishes (only with telemetry on and an org name set).
 * The benchmark is a trade: telemetry unlocks the two basic rows, and company
 * context (website, team size, use case) re-bases them on a peer group
 * (`level: "full"`), which also offers a monthly report. With telemetry off,
 * the card says what telemetry unlocks, but only while the telemetry banner
 * is not on screen: for non-admins, and for admins who dismissed the banner
 * on an earlier visit. The card's own X hides it for good.
 *
 * The perk is the bell's Slack Connect invite in a compact form: submitting or
 * dismissing it here resolves the same inbox row. It also shows alone once a
 * workflow has completed, until the invite is resolved.
 */
import { useQueryClient } from "@tanstack/react-query";
import { Lock, MessagesSquare, Users } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { useFleetBenchmark } from "@/api/hooks/use-fleet-benchmark";
import { useInboxState } from "@/api/hooks/use-inbox-state";
import { useEnableTelemetry } from "@/api/hooks/use-org-profile";
import { isUiTelemetryEnabled, useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import type { FleetBenchmarkResponse } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { FadeIn } from "@/components/shared/fade-in";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
import { SLACK_CONNECT_INVITE_KEY, useSlackConnectInvite } from "@/hooks/use-slack-connect-invite";
import {
  fleetCardMode,
  fleetPeerGroupNote,
  fleetPlacement,
  formatFleetMedian,
  formatFleetValue,
} from "@/lib/fleet-benchmark";
import {
  readTelemetryBannerDismissedAt,
  showTelemetryBanner,
  TELEMETRY_BANNER_CARD_KEY,
} from "@/lib/telemetry-banner";
import { isAdminLike } from "@/lib/user-role";
import { FleetReportForm, FleetUnlockFlow } from "./fleet-benchmark-forms";
import { HomeCard, HomeCardDivider, HomeCardNote } from "./home-card";

const TITLE = "Your swarm vs. similar swarms";
const TELEMETRY_DOCS_URL = "https://docs.agent-swarm.dev/docs/reference/telemetry";
/**
 * What the `full` level adds. The API returns the same two metrics against the
 * peer group, so these are the only locked rows it can fill.
 */
const PEER_ROWS = [
  "Tasks per week, against teams your size that do the same work",
  "Success rate, against teams your size that do the same work",
];

/**
 * One `fleet_benchmark.viewed` per page load and swarm (`config.apiUrl`),
 * however often Home re-mounts. Marked only once the event can leave.
 */
const viewedThisLoad = new Set<string>();

export function FleetBenchmarkCard() {
  const currentUser = useCurrentUser();
  const { data: status } = useStatusContext();
  const benchmark = useFleetBenchmark(Boolean(status));
  const benchmarkCard = useDismissibleCard("fleet-benchmark");
  const inbox = useInboxState({ userId: currentUser.userId, itemType: "notification" });
  const track = useUiTelemetry();
  const { config } = useConfig();
  // Read once: a banner dismissed on this page view does not swap in the off state.
  const [bannerDismissedAt] = useState(() =>
    readTelemetryBannerDismissedAt(deriveStorageKey(config.apiUrl, TELEMETRY_BANNER_CARD_KEY)),
  );
  const isAdmin = isAdminLike(currentUser.user);
  const telemetryOff = status?.telemetry?.enabled === false;
  // The telemetry banner sits right above and asks the same thing: never both.
  const bannerAsks = showTelemetryBanner({
    telemetryEnabled: false,
    isAdmin,
    dismissedAt: bannerDismissedAt,
  });

  const invite = inbox.data?.find((row) => row.itemId === SLACK_CONNECT_INVITE_KEY);
  const inviteOpen =
    Boolean(currentUser.userId) &&
    inbox.isSuccess &&
    invite?.status !== "dismissed" &&
    invite?.status !== "done";
  // The last `ready` payload. A refetch that fails or comes back `unavailable`
  // (for example the reload after an unlock) keeps it on screen with a Retry.
  const [lastReady, setLastReady] = useState<FleetBenchmarkResponse>();
  useEffect(() => {
    if (benchmark.data?.state === "ready") setLastReady(benchmark.data);
  }, [benchmark.data]);
  const refreshFailed =
    lastReady !== undefined && (benchmark.isError || benchmark.data?.state === "unavailable");
  const benchmarkData = refreshFailed ? lastReady : benchmark.data;
  const mode = fleetCardMode({
    benchmark: benchmarkData,
    benchmarkDismissed: benchmarkCard.dismissed,
    inviteOpen,
    workflowRunsCompleted: status?.instance?.workflow_runs_completed ?? 0,
    offStateAllowed: telemetryOff && !bannerAsks,
  });

  const shown = mode === "benchmark" || mode === "progress";
  const level = benchmarkData?.level;
  useEffect(() => {
    // `track` drops the event while `/status` loads or reports telemetry off.
    if (!shown || !isUiTelemetryEnabled(status) || viewedThisLoad.has(config.apiUrl)) return;
    viewedThisLoad.add(config.apiUrl);
    // The card only renders with an org name set; the property keeps the
    // catalog's shape for a later hint state.
    track({ event: "fleet_benchmark.viewed", properties: { has_org_name: true, level } });
  }, [shown, status, config.apiUrl, level, track]);
  // Turned on here, but no comparison yet: say so instead of vanishing.
  const [enabledHere, setEnabledHere] = useState(false);
  const enabledNote = enabledHere && !shown;

  if (!mode && !enabledNote) return null;
  if (mode === "perk" && !enabledNote) {
    return (
      <section
        aria-label="Slack Connect"
        className="w-full rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5"
      >
        <SlackPerk />
      </section>
    );
  }

  const data = benchmarkData as FleetBenchmarkResponse;
  return (
    <HomeCard
      icon={Users}
      title={TITLE}
      onDismiss={benchmarkCard.dismiss}
      dismissLabel="Dismiss the fleet benchmark"
    >
      {enabledNote ? (
        <FadeIn>
          <StatusLine tone="success">{enabledText(benchmarkData?.state)}</StatusLine>
        </FadeIn>
      ) : null}
      {mode === "off" && !enabledNote ? (
        <TelemetryOff isAdmin={isAdmin} onEnabled={() => setEnabledHere(true)} />
      ) : null}
      {mode === "benchmark" ? (
        <Benchmark
          data={data}
          isAdmin={isAdmin}
          refresh={
            refreshFailed
              ? { retry: () => void benchmark.refetch(), retrying: benchmark.isFetching }
              : undefined
          }
        />
      ) : null}
      {mode === "progress" ? (
        <p className="text-sm text-muted-foreground">
          Finish {data.minFinishedTasks} tasks in 30 days to compare (
          {data.local?.finishedTasks ?? 0} so far).
        </p>
      ) : null}
      {inviteOpen ? (
        <HomeCardDivider>
          <SlackPerk />
        </HomeCardDivider>
      ) : null}
    </HomeCard>
  );
}

function LockedList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-0.5 text-sm text-muted-foreground">
      {items.map((label) => (
        <li key={label} className="flex items-center gap-1.5">
          <Lock className="size-3 shrink-0" aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}

function enabledText(state: FleetBenchmarkResponse["state"] | undefined): string {
  if (state === "no_org_name") return "Telemetry is on. Set an organization name to compare.";
  if (state === "unavailable") {
    return "Telemetry is on. The comparison shows here as soon as it is available.";
  }
  return "Telemetry is on.";
}

/** Telemetry is off: what it unlocks. Turning it on is an admin action. */
function TelemetryOff({ isAdmin, onEnabled }: { isAdmin: boolean; onEnabled: () => void }) {
  const enableTelemetry = useEnableTelemetry();
  const queryClient = useQueryClient();

  function turnOn() {
    enableTelemetry.mutate("benchmark", {
      onSuccess: () => {
        onEnabled();
        void queryClient.invalidateQueries({ queryKey: ["fleet-benchmark"] });
      },
      onError: () => toast.error("Could not turn telemetry on. Please try again."),
    });
  }

  return (
    <>
      <LockedList items={["Tasks per week", "Success rate"]} />
      <HomeCardNote>
        Turn on anonymized telemetry to see where your swarm stands. It sends usage counts, setup
        facts, your swarm name, website and email domain. Never prompts, task content, user names or
        email addresses.{" "}
        <a
          href={TELEMETRY_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          What we collect
        </a>
      </HomeCardNote>
      {isAdmin ? (
        <Button size="sm" disabled={enableTelemetry.isPending} onClick={turnOn}>
          {enableTelemetry.isPending ? "Turning on…" : "Turn on telemetry"}
        </Button>
      ) : (
        <HomeCardNote>An admin can turn it on in Settings.</HomeCardNote>
      )}
    </>
  );
}

function Benchmark({
  data,
  isAdmin,
  refresh,
}: {
  data: FleetBenchmarkResponse;
  isAdmin: boolean;
  /** Set when the last reload failed: `data` is the last good payload. */
  refresh?: { retry: () => void; retrying: boolean };
}) {
  const [unlocking, setUnlocking] = useState(false);
  return (
    <>
      {data.level === "full" ? (
        <HomeCardNote>{fleetPeerGroupNote(data.peerGroup)}</HomeCardNote>
      ) : null}
      <ul className="space-y-0.5 text-sm text-muted-foreground">
        {data.comparisons.map((comparison) => (
          <li key={comparison.key}>
            <span className="font-medium text-foreground">{formatFleetValue(comparison)}</span>,{" "}
            {fleetPlacement(comparison)}{" "}
            <span className="text-xs">(median {formatFleetMedian(comparison)})</span>
          </li>
        ))}
      </ul>
      {refresh ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusLine tone="error">Could not refresh the comparison.</StatusLine>
          <Button size="xs" variant="outline" disabled={refresh.retrying} onClick={refresh.retry}>
            {refresh.retrying ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : null}
      {data.level === "basic" ? (
        <>
          <LockedList items={PEER_ROWS} />
          {!isAdmin ? (
            <HomeCardNote>
              An admin can unlock these by adding the company details in Settings.
            </HomeCardNote>
          ) : unlocking ? null : (
            <Button size="sm" variant="outline" onClick={() => setUnlocking(true)}>
              Compare with teams like yours
            </Button>
          )}
          <AnimatedReveal open={unlocking}>
            <HomeCardDivider>
              <FleetUnlockFlow onCancel={() => setUnlocking(false)} />
            </HomeCardDivider>
          </AnimatedReveal>
        </>
      ) : null}
      {data.level === "full" ? <FleetReportForm /> : null}
    </>
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
