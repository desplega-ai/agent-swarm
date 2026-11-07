import { AlertCircle, ArrowUpRight, FolderOpen, RotateCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { StatusProvider } from "@/app/status-context";
import { AGENT_FS_UPGRADE_HINT, PasteKeyForm } from "@/components/comb/connect-card";
import { connectWithKey } from "@/components/comb/connect-flow";
import { useAutoConnect } from "@/components/comb/use-auto-connect";
import { useConnectFlowDeps } from "@/components/comb/use-connect-flow-deps";
import { setupExitHref } from "@/components/onboarding/onboarding-redirect";
import { setupStepHref } from "@/components/onboarding/step-status";
import { SetupCard } from "@/components/shared/setup-card";
import { StatusIcon } from "@/components/shared/status-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { AgentFsProvider, useAgentFs } from "@/contexts/agent-fs-context";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useContinueBlocker } from "@/hooks/use-autosave";
import type { StepProps } from "../step-contract";
import { CombPreview } from "./files/comb-preview";

type FilesMethod = "created" | "connected";

/**
 * `/setup` runs outside the app shell, so it has neither the `/status`
 * snapshot nor the agent-fs connection. The step mounts both for itself.
 */
export function StepFiles(props: StepProps) {
  return (
    <StatusProvider pollIntervalMs={30_000}>
      <AgentFsProvider>
        <StepFilesBody {...props} />
      </AgentFsProvider>
    </StatusProvider>
  );
}

/** A 403 from `act`: a non-admin cannot write onboarding, but the account exists. */
function isForbidden(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 403;
}

/**
 * Files: get this browser its own named agent-fs key through the swarm, with
 * no click (Comb's own `useAutoConnect`). The swarm makes the person's agent-fs
 * account ready on the way. The paste-key form shows only when agent-fs is too
 * old for named keys.
 */
export function StepFilesBody({ onboarding, act, setContinueBlocker }: StepProps) {
  const { state, endpoint, orgId, driveId, retry: recheck } = useAgentFs();
  const deps = useConnectFlowDeps();
  const auto = useAutoConnect();
  const { user } = useCurrentUser();
  const email = user?.email?.trim() || null;
  const stepDone = onboarding.state.steps.files.status === "done";
  const driveReady = orgId !== null && driveId !== null;

  const [pasteKey, setPasteKey] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  // `complete` runs once per mount, for the first `ready`.
  const completed = useRef(false);
  const minting =
    auto.running ||
    (auto.outcome === null && (state === "needs-connect" || state === "invalid-key"));

  useContinueBlocker(setContinueBlocker, minting ? "Creating your files account…" : null, {
    busy: minting,
  });

  const complete = useCallback(
    async (method: FilesMethod) => {
      try {
        await act({ action: "complete", step: "files", method });
      } catch (err) {
        // The account exists either way. A non-admin cannot write onboarding.
        if (!isForbidden(err)) console.warn("[setup] files step not saved", err);
      }
    },
    [act],
  );

  const minted = auto.outcome?.kind === "connected";
  useEffect(() => {
    if (state !== "ready" || completed.current || !endpoint) return;
    completed.current = true;
    if (!stepDone) void complete(minted ? "created" : "connected");
  }, [state, endpoint, stepDone, minted, complete]);

  async function onPaste(event: FormEvent) {
    event.preventDefault();
    const key = pasteKey.trim();
    if (!key || !deps) return;
    setPasteBusy(true);
    setPasteError(null);
    const outcome = await connectWithKey(deps, key);
    setPasteBusy(false);
    if (outcome.kind === "failed") setPasteError(outcome.message);
  }

  const done = state === "ready";
  const outcome = minting ? null : auto.outcome;
  // The picture explains the step. A state that needs the person's action shows alone.
  const showPreview = state !== "disabled" && (done || minting);

  return (
    <div className="flex flex-col gap-4">
      {email && !done ? (
        <p className="max-w-[70ch] text-sm text-muted-foreground">
          We create your files account with{" "}
          <span className="font-medium text-foreground">{email}</span>.
        </p>
      ) : null}

      {done ? (
        <SetupCard
          icon={<FolderOpen className="size-5" />}
          title="Your files account is ready."
          description="This browser has its own named agent-fs key. Revoke it any time in agent-fs."
          actions={
            <Button asChild variant="outline" size="sm">
              {/* A new tab keeps setup open in this one. */}
              <Link
                to={setupExitHref("/file")}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open your files"
              >
                {/* A phone keeps the title room: the button says "Open". */}
                Open<span className="hidden sm:inline"> your files</span>
                <ArrowUpRight />
              </Link>
            </Button>
          }
          status={<StatusIcon tone="done" label="Connected" />}
        />
      ) : state === "disabled" ? (
        <AlertCallout tone="warning" icon={AlertCircle}>
          Files is off on this swarm. Skip this step.
        </AlertCallout>
      ) : state === "unreachable" ? (
        <AlertCallout tone="error" icon={AlertCircle} title="Cannot reach agent-fs">
          <Button variant="outline" size="sm" className="mt-1" onClick={recheck}>
            <RotateCw />
            Retry
          </Button>
        </AlertCallout>
      ) : !email ? (
        <AlertCallout tone="info" icon={AlertCircle}>
          <p>
            Add your email in step 1 to create your files account.{" "}
            <Link to={setupStepHref("connect")} replace className="underline underline-offset-2">
              Go to step 1
            </Link>
          </p>
        </AlertCallout>
      ) : outcome?.kind === "unsupported" ? (
        <SetupCard title="Paste an agent-fs key" description={AGENT_FS_UPGRADE_HINT}>
          <PasteKeyForm
            notice={null}
            apiKey={pasteKey}
            onApiKeyChange={setPasteKey}
            busy={pasteBusy}
            disabled={!driveReady}
            onSubmit={(event) => void onPaste(event)}
          />
          {pasteError ? (
            <AlertCallout tone="error" icon={AlertCircle} className="mt-3">
              {pasteError}
            </AlertCallout>
          ) : null}
        </SetupCard>
      ) : outcome?.kind === "pending" ? (
        <AlertCallout tone="warning" icon={AlertCircle} title="Your files account is not ready yet">
          <p>{outcome.reason}</p>
          <RetryButton onRetry={auto.retry} />
        </AlertCallout>
      ) : outcome?.kind === "failed" ? (
        <AlertCallout tone="error" icon={AlertCircle} title="Could not create your files account">
          <p>{outcome.message}</p>
          <RetryButton onRetry={auto.retry} />
        </AlertCallout>
      ) : outcome?.kind === "connected" && state === "invalid-key" ? (
        <AlertCallout
          tone="warning"
          icon={AlertCircle}
          title="agent-fs no longer accepts this browser's key"
        >
          <RetryButton onRetry={auto.retry} />
        </AlertCallout>
      ) : (
        <SetupCard
          icon={<FolderOpen className="size-5" />}
          title="Creating your files account…"
          description="This takes a few seconds."
          status={<StatusIcon tone="busy" label="Creating your files account" />}
        />
      )}

      {/* Stays mounted from creating to done, so its beats play once. */}
      {showPreview ? <CombPreview /> : null}
    </div>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
      <RotateCw />
      Retry
    </Button>
  );
}
