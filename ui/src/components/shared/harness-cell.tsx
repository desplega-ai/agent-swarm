import type { AgentCredStatus, ProviderName } from "@/api/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { HarnessIcon } from "./harness-icon";
import { ReasoningEffortIcon } from "./reasoning-effort-icon";

const HARNESS_LABEL: Record<string, string> = {
  claude: "Claude",
  "claude-managed": "Claude (managed)",
  codex: "Codex",
  devin: "Devin",
  opencode: "Opencode",
  pi: "Pi-Mono",
};

type CredHealth = "verified" | "configured" | "blocked" | "untested" | "unreported";

function classifyCred(s: AgentCredStatus | null | undefined): CredHealth {
  if (!s) return "unreported";
  if (!s.ready) return "blocked";
  if (s.liveTest?.ok === true) return "verified";
  if (s.liveTest && s.liveTest.ok === false) return "configured"; // presence ok, live failed
  return "untested";
}

const HEALTH_DOT: Record<CredHealth, string> = {
  verified: "bg-status-success",
  configured: "bg-status-warning",
  untested: "bg-status-pending",
  blocked: "bg-status-error",
  unreported: "bg-status-neutral",
};

const HEALTH_LABEL: Record<CredHealth, string> = {
  verified: "Verified",
  configured: "Live test failed",
  untested: "Presence ok, untested",
  blocked: "Missing credentials",
  unreported: "Unreported",
};

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 0) return "just now";
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export interface HarnessCellProps {
  harnessProvider: ProviderName | string | null | undefined;
  credStatus: AgentCredStatus | null | undefined;
  className?: string;
}

export function HarnessCell({ harnessProvider, credStatus, className }: HarnessCellProps) {
  if (!harnessProvider) {
    return <span className="text-muted-foreground">—</span>;
  }
  const label = HARNESS_LABEL[harnessProvider] ?? harnessProvider;
  const health = classifyCred(credStatus);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 cursor-default text-foreground",
            className,
          )}
        >
          <HarnessIcon harness={String(harnessProvider)} />
          <span className="font-medium">{label}</span>
          <span
            aria-hidden
            className={cn("h-1.5 w-1.5 rounded-full shrink-0", HEALTH_DOT[health])}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="max-w-xs px-3 py-2.5 text-left whitespace-normal"
      >
        <CredBreakdown
          provider={String(harnessProvider)}
          providerLabel={label}
          credStatus={credStatus ?? null}
          health={health}
        />
      </TooltipContent>
    </Tooltip>
  );
}

function CredBreakdown({
  provider,
  providerLabel,
  credStatus,
  health,
}: {
  provider: string;
  providerLabel: string;
  credStatus: AgentCredStatus | null;
  health: CredHealth;
}) {
  return (
    <div className="text-xs leading-relaxed space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{providerLabel}</span>
        <span className="opacity-70">({provider})</span>
      </div>

      <div className="flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 rounded-full", HEALTH_DOT[health])} />
        <span className="font-medium">{HEALTH_LABEL[health]}</span>
      </div>

      {!credStatus ? (
        <p className="opacity-80">
          Worker hasn't reported credential state yet, or `CRED_CHECK_DISABLE=1` is set.
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 opacity-90">
          <dt className="opacity-60">Presence</dt>
          <dd>{credStatus.ready ? "ready" : "not ready"}</dd>

          {credStatus.satisfiedBy ? (
            <>
              <dt className="opacity-60">Satisfied by</dt>
              <dd>{credStatus.satisfiedBy}</dd>
            </>
          ) : null}

          {credStatus.liveTest ? (
            <>
              <dt className="opacity-60">Live test</dt>
              <dd>
                {credStatus.liveTest.ok ? "passed" : "failed"} · {credStatus.liveTest.latency_ms}ms
                {" · "}
                {formatRelative(credStatus.liveTest.testedAt)}
              </dd>
              {credStatus.liveTest.error ? (
                <>
                  <dt className="opacity-60">Error</dt>
                  <dd className="break-words">{credStatus.liveTest.error}</dd>
                </>
              ) : null}
            </>
          ) : (
            <>
              <dt className="opacity-60">Live test</dt>
              <dd className="opacity-70">not run</dd>
            </>
          )}

          {credStatus.latestModel ? (
            <>
              <dt className="opacity-60">Latest model</dt>
              <dd className="break-words font-mono">
                {credStatus.latestModel.model}
                {credStatus.latestModel.source ? ` · ${credStatus.latestModel.source}` : ""}
              </dd>
            </>
          ) : null}

          {credStatus.latestModel?.reasoningEffort ? (
            <>
              <dt className="opacity-60">Effort</dt>
              <dd className="flex items-center gap-1.5 font-mono">
                <ReasoningEffortIcon level={credStatus.latestModel.reasoningEffort} />
                {credStatus.latestModel.reasoningEffort}
              </dd>
            </>
          ) : null}

          {credStatus.missing && credStatus.missing.length > 0 ? (
            <>
              <dt className="opacity-60">Missing</dt>
              <dd className="break-words">{credStatus.missing.join(", ")}</dd>
            </>
          ) : null}

          {credStatus.hint ? (
            <>
              <dt className="opacity-60">Hint</dt>
              <dd className="break-words">{credStatus.hint}</dd>
            </>
          ) : null}

          <dt className="opacity-60">Reported</dt>
          <dd>
            {formatRelative(credStatus.reportedAt)}
            {credStatus.reportKind ? ` · ${credStatus.reportKind}` : ""}
          </dd>
        </dl>
      )}
    </div>
  );
}
