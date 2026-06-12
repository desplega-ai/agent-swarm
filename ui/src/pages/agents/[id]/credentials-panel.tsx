import type { Agent, AgentBedrockStatus, AgentCredStatus } from "@/api/types";
import { HarnessCell } from "@/components/shared/harness-cell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DefinitionList, InfoRow } from "@/components/ui/info-row";
import { cn } from "@/lib/utils";

type CredHealth = "verified" | "configured" | "blocked" | "untested" | "unreported";

function classify(s: AgentCredStatus | null | undefined): CredHealth {
  if (!s) return "unreported";
  if (!s.ready) return "blocked";
  if (s.liveTest?.ok === true) return "verified";
  if (s.liveTest && s.liveTest.ok === false) return "configured";
  return "untested";
}

const TONE: Record<CredHealth, { dot: string; ring: string; label: string; help: string }> = {
  verified: {
    dot: "bg-status-success",
    ring: "border-status-success/30",
    label: "Verified",
    help: "At least one live test passed within the verify TTL.",
  },
  configured: {
    dot: "bg-status-warning",
    ring: "border-status-warning/30",
    label: "Live test failed",
    help: "Presence check OK, but the worker's last live test against the upstream API failed.",
  },
  untested: {
    dot: "bg-status-pending",
    ring: "border-status-pending/30",
    label: "Presence ok, untested",
    help: "Worker has the credentials but no live upstream call has been made yet (boot fast-path or live test disabled).",
  },
  blocked: {
    dot: "bg-status-error",
    ring: "border-status-error/30",
    label: "Missing credentials",
    help: "Worker reported one or more required env vars / auth files are not present. It will park on `waiting_for_credentials`.",
  },
  unreported: {
    dot: "bg-status-neutral",
    ring: "border-status-neutral/30",
    label: "Unreported",
    help: "Worker hasn't reported credential state yet — still booting, or `CRED_CHECK_DISABLE=1` is set.",
  },
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

// ---------------------------------------------------------------------------
// BedrockProbeCard — renders pi-harness Bedrock probe status with parity to
// the overall CredentialsPanel tone/dot pattern.
// ---------------------------------------------------------------------------

function BedrockProbeCard({ bedrock }: { bedrock: AgentBedrockStatus | null | undefined }) {
  const dot =
    bedrock == null ? "bg-status-neutral" : bedrock.ready ? "bg-status-success" : "bg-status-error";
  const ring =
    bedrock == null
      ? "border-status-neutral/30"
      : bedrock.ready
        ? "border-status-success/30"
        : "border-status-error/30";
  const label =
    bedrock == null
      ? "AWS probe pending"
      : bedrock.ready
        ? "AWS Bedrock ready"
        : "AWS Bedrock blocked";
  const help =
    bedrock == null
      ? "Worker hasn't reported Bedrock status yet — still booting, not in Bedrock mode, or CRED_CHECK_DISABLE is set."
      : bedrock.ready
        ? "Probe succeeded — the SDK credential chain is valid for this region."
        : "Probe failed. Worker is parked at credential-wait. Check AWS credentials and AWS_REGION.";

  return (
    <Card className={cn("border", ring)}>
      <CardContent className="p-4 space-y-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className={cn("h-2 w-2 rounded-full", dot)} />
            <span className="font-semibold text-sm">{label}</span>
          </div>
          <p className="text-xs text-muted-foreground max-w-prose">{help}</p>
        </div>

        {bedrock != null ? (
          <DefinitionList>
            <InfoRow label="Probe status">
              {bedrock.ready ? (
                <Badge
                  variant="outline"
                  size="tag"
                  className="border-status-success/30 text-status-success-strong"
                >
                  ready
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  size="tag"
                  className="border-status-error/30 text-status-error-strong"
                >
                  blocked
                </Badge>
              )}
            </InfoRow>
            <InfoRow label="Region">
              <code className="text-xs">{bedrock.region}</code>
            </InfoRow>
            {bedrock.error ? (
              <InfoRow label="Probe error">
                <pre className="bg-muted/50 p-2 rounded text-xs font-mono whitespace-pre-wrap break-words">
                  {bedrock.error}
                </pre>
              </InfoRow>
            ) : null}
            <InfoRow label="Usable models">
              {bedrock.models.length > 0 ? (
                <span>
                  {bedrock.models.length} model{bedrock.models.length === 1 ? "" : "s"}
                </span>
              ) : (
                <span className="text-muted-foreground">none reported</span>
              )}
            </InfoRow>
            <InfoRow label="Probed">{formatRelative(bedrock.probedAt)}</InfoRow>
          </DefinitionList>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function CredentialsPanel({ agent }: { agent: Agent }) {
  const cred = agent.credStatus ?? null;
  const health = classify(cred);
  const tone = TONE[health];

  // Show Bedrock probe card for pi-harness agents — whether or not a probe
  // has run yet (the "pending" state is also informative).
  const showBedrockPanel = agent.harnessProvider === "pi";

  return (
    <div className="space-y-4">
      <Card className={cn("border", tone.ring)}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", tone.dot)} />
                <span className="font-semibold text-sm">{tone.label}</span>
              </div>
              <p className="text-xs text-muted-foreground max-w-prose">{tone.help}</p>
            </div>
            <HarnessCell
              harnessProvider={agent.harnessProvider}
              credStatus={cred}
              className="text-sm"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <DefinitionList>
            <InfoRow label="Harness provider">
              {agent.harnessProvider ?? <span className="text-muted-foreground">—</span>}
            </InfoRow>
            <InfoRow label="Presence">
              {cred ? (
                <span>{cred.ready ? "ready" : "not ready"}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </InfoRow>
            <InfoRow label="Satisfied by">
              {cred?.satisfiedBy ? (
                <Badge variant="outline" size="tag">
                  {cred.satisfiedBy}
                </Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </InfoRow>
            <InfoRow label="Live test">
              {cred?.liveTest ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        cred.liveTest.ok ? "bg-status-success" : "bg-status-error",
                      )}
                    />
                    <span>
                      {cred.liveTest.ok ? "passed" : "failed"} · {cred.liveTest.latency_ms}ms ·{" "}
                      <span className="text-muted-foreground">
                        {formatRelative(cred.liveTest.testedAt)}
                      </span>
                    </span>
                  </div>
                  {cred.liveTest.error ? (
                    <pre className="bg-muted/50 p-2 rounded text-xs font-mono whitespace-pre-wrap break-words">
                      {cred.liveTest.error}
                    </pre>
                  ) : null}
                </div>
              ) : (
                <span className="text-muted-foreground">not run</span>
              )}
            </InfoRow>
            {cred && cred.missing.length > 0 ? (
              <InfoRow label="Missing">
                <div className="flex flex-wrap gap-1 mt-1">
                  {cred.missing.map((k) => (
                    <Badge
                      key={k}
                      variant="outline"
                      size="tag"
                      className="border-status-error/30 text-status-error-strong"
                    >
                      {k}
                    </Badge>
                  ))}
                </div>
              </InfoRow>
            ) : null}
            {cred?.hint ? <InfoRow label="Hint">{cred.hint}</InfoRow> : null}
            <InfoRow label="Reported">
              {cred ? (
                <span>
                  {formatRelative(cred.reportedAt)}
                  {cred.reportKind ? (
                    <span className="text-muted-foreground"> · {cred.reportKind}</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </InfoRow>
          </DefinitionList>
        </CardContent>
      </Card>

      {/* Bedrock probe status — pi harness only, parity with the main cred panel */}
      {showBedrockPanel ? <BedrockProbeCard bedrock={agent.credStatus?.bedrock} /> : null}

      {/* Legacy waiting-for-credentials column is preserved below for older
          workers that haven't started reporting cred_status JSON yet. */}
      {!cred && agent.credentialMissing && agent.credentialMissing.length > 0 ? (
        <Card className="border-status-warning/30">
          <CardContent className="p-4 space-y-2">
            <InfoRow label="Legacy waiting_for_credentials report">
              <div className="flex flex-wrap gap-1 mt-1">
                {agent.credentialMissing.map((k) => (
                  <Badge
                    key={k}
                    variant="outline"
                    size="tag"
                    className="border-status-warning/30 text-status-warning-strong"
                  >
                    {k}
                  </Badge>
                ))}
              </div>
            </InfoRow>
            <p className="text-xs text-muted-foreground">
              This worker reports the older `credentialMissing` array but no `cred_status` snapshot.
              It will start populating the snapshot once it restarts on a build that includes
              migration 055.
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
