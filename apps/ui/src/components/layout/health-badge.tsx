/**
 * The header health badge, from `/status` health. A click opens a popover:
 * the failing checks with their fix links and, while no worker is online, the
 * command that starts one. All green says so, with a link to `/setup` while
 * onboarding is not finished. The popover polls `/status` while it is open,
 * so the wait for a worker ends by itself.
 */
import { ArrowRight, Check, Copy, ExternalLink } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { useStatus } from "@/api/hooks";
import { useSubmitFeedback } from "@/api/hooks/use-feedback";
import { isOnboardingFinished, useOnboarding } from "@/api/hooks/use-onboarding";
import { useApiVersion } from "@/api/hooks/use-stats";
import { useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import type {
  MilestoneId,
  ProviderName,
  SetupMilestone,
  StatusHealth,
  StatusResponse,
} from "@/api/types";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { BorderBeam } from "@/components/shared/border-beam";
import { StatusIcon, StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { HARNESS_LABEL } from "@/lib/agent-runtime-models";
import { cn } from "@/lib/utils";
import {
  WORKER_HARNESSES,
  WORKER_TARGET_DOCS,
  WORKER_TARGETS,
  type WorkerTarget,
  workerStartCommand,
} from "@/lib/worker-start-commands";

const HEALTH_DOT_CLASS: Record<StatusHealth, string> = {
  ok: "bg-status-success",
  degraded: "bg-status-pending",
  broken: "bg-status-error",
};

const HEALTH_LABEL: Record<StatusHealth, string> = {
  ok: "All systems go",
  degraded: "Needs attention",
  broken: "Setup required",
};

/** The header polls every 30 s. An open popover polls faster, to catch a new worker. */
const OPEN_POLL_MS = 3_000;

const TARGET_NOTE: Record<WorkerTarget, string> = {
  compose: "Run it next to docker-compose.yml. Every agent in the stack gets this harness.",
  docker: "Replace your-api-key with the swarm API key. MCP_BASE_URL must reach this API.",
  kubernetes: "Release, namespace and values file as in the Kubernetes guide.",
};

interface FailingCheck {
  /** A setup milestone, or `lead`: no lead can take work (`activity.leads_ready`). */
  milestone: Omit<SetupMilestone, "id"> & { id: MilestoneId | "lead" };
  /** `true` turns the badge red: no task can run. */
  blocks: boolean;
}

/** The checks behind a red or amber badge, by the rules of `computeHealth` in src/http/status.ts. */
function failingChecks({ setup, activity }: StatusResponse): FailingCheck[] {
  const checks = setup.flatMap((milestone): FailingCheck[] => {
    const { id, state } = milestone;
    if ((id === "harness" || id === "workers") && state === "unverified") {
      return [{ milestone, blocks: true }];
    }
    if (["harness", "slack", "github", "linear", "jira"].includes(id) && state === "configured") {
      return [{ milestone, blocks: false }];
    }
    return [];
  });
  // With no agents at all, the workers check already says it.
  const noAgents = setup.some((m) => m.id === "workers" && m.state === "unverified");
  if (activity.leads_ready === 0 && !noAgents) {
    checks.push({
      milestone: {
        id: "lead",
        label: "No lead online",
        state: "unverified",
        hint: "Start the lead. New tasks wait until it is online.",
        action_url: "/agents",
      },
      blocks: false,
    });
  }
  return checks;
}

export function HealthBadge({ status }: { status: StatusResponse }) {
  const sendEvent = useUiTelemetry();
  const [open, setOpen] = useState(false);
  const health = status.health;

  const badge = (
    <button
      type="button"
      aria-label={`Swarm health: ${HEALTH_LABEL[health]}`}
      className={cn(
        "hit-area flex items-center gap-2 rounded-md px-2 py-1 text-xs",
        "hover:bg-accent transition-colors data-[state=open]:bg-accent",
        "text-muted-foreground",
      )}
    >
      <span className={cn("size-2 rounded-full", HEALTH_DOT_CLASS[health])} />
      {/* The connection name and version live in the sidebar swarm
          switcher; the header only carries health. */}
      <span className="hidden sm:inline">{HEALTH_LABEL[health]}</span>
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) sendEvent({ event: "feature.used", properties: { feature: "health_popover" } });
      }}
    >
      <PopoverTrigger asChild>{badge}</PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Swarm health"
        className="max-h-(--radix-popover-content-available-height) w-[26rem] max-w-[calc(100vw-1rem)] space-y-3 overflow-y-auto"
      >
        <HealthPopoverBody status={status} onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** Mounted only while the popover is open. */
function HealthPopoverBody({
  status,
  onNavigate,
}: {
  status: StatusResponse;
  onNavigate: () => void;
}) {
  const live = useStatus({ pollIntervalMs: OPEN_POLL_MS }).data ?? status;
  const checks = failingChecks(live);
  const workersOnline = live.activity.agents_online - live.activity.leads_online;
  const needsWorker = live.health === "broken" && workersOnline === 0;
  // Remember the wait, so a worker that shows up while open is announced.
  const [waited, setWaited] = useState(needsWorker);
  useEffect(() => {
    if (needsWorker) setWaited(true);
  }, [needsWorker]);
  const registered = waited && workersOnline > 0;

  const [target, setTarget] = useState<WorkerTarget>("compose");
  const [harness, setHarness] = useState<ProviderName>("claude");

  const firstTask = live.setup.find((milestone) => milestone.id === "first_task");
  const provider = live.setup.find((milestone) => milestone.id === "harness")?.provider;
  const onboarding = useOnboarding().data;
  const setupUnfinished = Boolean(onboarding && !isOnboardingFinished(onboarding.state));

  return (
    <>
      <div>
        <p className="text-sm font-medium">{HEALTH_LABEL[live.health]}</p>
        {live.health === "broken" ? (
          <p className="text-xs text-muted-foreground">No task can run until these pass.</p>
        ) : null}
        {live.health === "ok" ? (
          <p className="text-xs text-muted-foreground">All checks pass.</p>
        ) : null}
      </div>

      {live.health === "ok" && setupUnfinished && !registered ? (
        <Button asChild size="xs" variant="outline">
          <Link to="/setup" onClick={onNavigate}>
            Finish setup
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      ) : null}

      {checks.length > 0 ? (
        <ul className="space-y-2.5">
          {checks.map(({ milestone, blocks }) => (
            <li key={milestone.id} className="flex items-start gap-2">
              {/* Not focusable: the popover focuses its first stop on open,
                  which would pop this tooltip every time. */}
              <StatusIcon
                tone={blocks ? "error" : "warning"}
                label={blocks ? "Blocks tasks" : "Needs attention"}
                focusable={false}
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug">{milestone.label}</p>
                {milestone.hint ? (
                  <p className="text-xs text-muted-foreground">{milestone.hint}</p>
                ) : null}
              </div>
              {milestone.action_url ? (
                <Button asChild size="xs" variant="outline">
                  <Link
                    to={milestone.action_url}
                    onClick={onNavigate}
                    aria-label={`Fix ${milestone.label}`}
                  >
                    Fix
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {needsWorker ? (
        <StartWorker
          target={target}
          harness={harness}
          onTargetChange={setTarget}
          onHarnessChange={setHarness}
        />
      ) : registered ? (
        <output className="block space-y-2 rounded-md border p-3">
          <StatusLine tone="success">
            Worker registered{provider ? ` (${HARNESS_LABEL[provider] ?? provider})` : ""}
          </StatusLine>
          {firstTask && firstTask.state !== "verified" ? (
            <>
              <span className="block text-xs text-muted-foreground">
                Next: send a first task. It confirms the swarm runs end to end.
              </span>
              <Button asChild size="xs" variant="outline">
                <Link to={firstTask.action_url ?? "/tasks?new=true"} onClick={onNavigate}>
                  New task
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </>
          ) : null}
        </output>
      ) : null}

      <SetupHelp
        health={live.health}
        checks={checks}
        picks={needsWorker ? { target, harness } : null}
      />
    </>
  );
}

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

function StartWorker({
  target,
  harness,
  onTargetChange,
  onHarnessChange,
}: {
  target: WorkerTarget;
  harness: ProviderName;
  onTargetChange: (target: WorkerTarget) => void;
  onHarnessChange: (harness: ProviderName) => void;
}) {
  const sendEvent = useUiTelemetry();
  const { config } = useConfig();
  const version = useApiVersion().data;
  const { copied, copy } = useCopyToClipboard();
  const targetLabelId = useId();
  const harnessId = useId();

  const command = workerStartCommand(target, harness, { apiUrl: config.apiUrl, version });
  const harnessLabel = HARNESS_LABEL[harness] ?? harness;
  const loginDocs = WORKER_HARNESSES.find((option) => option.value === harness)?.loginDocs;

  async function copyCommand() {
    if (await copy(command)) {
      sendEvent({ event: "setup.worker_command_copied", properties: { target, harness } });
    }
  }

  return (
    <div className="relative space-y-3 rounded-md border p-3">
      <BorderBeam />
      <p className="text-sm font-medium">Start a worker</p>
      <div className="space-y-1.5">
        <Label id={targetLabelId} className="text-xs">
          Where will it run?
        </Label>
        <SegmentedControl
          size="sm"
          aria-labelledby={targetLabelId}
          value={target}
          onValueChange={onTargetChange}
          options={WORKER_TARGETS}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={harnessId} className="text-xs">
          Harness
        </Label>
        <Select
          value={harness}
          onValueChange={(value) => {
            const next = WORKER_HARNESSES.find((option) => option.value === value);
            if (next) onHarnessChange(next.value);
          }}
        >
          <SelectTrigger id={harnessId} size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKER_HARNESSES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {HARNESS_LABEL[option.value] ?? option.value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-start gap-1.5">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted p-2 font-mono text-meta leading-relaxed">
          {command}
        </pre>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={copied ? "Copied" : "Copy command"}
          onClick={() => void copyCommand()}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {TARGET_NOTE[target]} <DocLink href={WORKER_TARGET_DOCS[target]}>Guide</DocLink>
      </p>
      {loginDocs ? (
        <p className="text-xs text-muted-foreground">
          The worker also needs a {harnessLabel} login.{" "}
          <DocLink href={loginDocs}>Login guide</DocLink>
        </p>
      ) : null}
      <output className="block border-t border-border-subtle pt-3">
        <StatusLine tone="busy">Waiting for a worker…</StatusLine>
      </output>
    </div>
  );
}

/**
 * "Stuck?": a consented ask for help. It posts to the feedback endpoint from
 * the browser (`useSubmitFeedback`), like the Slack Connect invite. The
 * install id rides along only while telemetry is on. No telemetry event: the API refuses `lead.captured`
 * from the dashboard (src/telemetry-ui-events.ts).
 */
function SetupHelp({
  health,
  checks,
  picks,
}: {
  health: StatusHealth;
  checks: FailingCheck[];
  picks: { target: WorkerTarget; harness: ProviderName } | null;
}) {
  const currentUser = useCurrentUser();
  const submit = useSubmitFeedback();

  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [email, setEmail] = useState(currentUser.user?.email ?? "");
  const consentId = useId();

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userId = currentUser.userId;
    if (!consent || !userId) return;
    const checkList = checks.map(({ milestone }) => `${milestone.id}:${milestone.state}`).join(",");
    const pickText = picks ? ` target=${picks.target} harness=${picks.harness}` : "";
    submit.mutate({
      submission_id: crypto.randomUUID(),
      user_id: userId,
      swarm_version: __APP_VERSION__,
      email: email.trim(),
      newsletter_consent: false,
      message: `[setup_help] health=${health} checks=${checkList || "none"}${pickText}`,
      submitted_at: new Date().toISOString(),
    });
  }

  const sentTo = submit.isSuccess ? submit.variables?.email : null;
  // The request carries the user id: without a picked user it cannot go.
  const needsUser = !currentUser.userId;

  return (
    <div className="border-t border-border-subtle pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Stuck? Ask us
      </button>
      <AnimatedReveal open={open}>
        <form className="space-y-2 pt-2" onSubmit={send}>
          <div className="flex items-start gap-2">
            <Switch
              id={consentId}
              checked={consent}
              onCheckedChange={setConsent}
              className="mt-0.5"
            />
            <Label htmlFor={consentId} className="text-xs font-normal leading-snug">
              {picks
                ? "Send my email, the checks above and my picks to Desplega."
                : "Send my email and the checks above to Desplega."}{" "}
              We reply within a business day.
            </Label>
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              type="email"
              required
              aria-label="Work email"
              placeholder="you@company.com"
              value={email}
              disabled={!consent || Boolean(sentTo)}
              onChange={(event) => setEmail(event.target.value)}
              className="h-7 text-xs"
            />
            <Button
              type="submit"
              size="xs"
              disabled={
                needsUser || !consent || !email.trim() || submit.isPending || Boolean(sentTo)
              }
            >
              {submit.isPending ? "Sending…" : "Ask"}
            </Button>
          </div>
          {needsUser ? (
            <p className="text-xs text-muted-foreground">Pick who you are first.</p>
          ) : null}
          {sentTo ? (
            <p className="text-xs text-status-success-strong">Sent. We reply to {sentTo}.</p>
          ) : null}
          {submit.error ? (
            <p className="text-xs text-status-error-strong">{submit.error.message}</p>
          ) : null}
        </form>
      </AnimatedReveal>
    </div>
  );
}
