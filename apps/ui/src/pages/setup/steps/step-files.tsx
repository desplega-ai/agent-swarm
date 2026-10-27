import { AlertCircle, ArrowUpRight, FolderOpen, RotateCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { StatusProvider } from "@/app/status-context";
import { PasteKeyForm } from "@/components/comb/connect-card";
import {
  type ConnectOutcome,
  connectWithKey,
  createAndConnect,
} from "@/components/comb/connect-flow";
import { useConnectFlowDeps } from "@/components/comb/use-connect-flow-deps";
import { setupExitHref } from "@/components/onboarding/onboarding-redirect";
import { setupStepHref } from "@/components/onboarding/step-status";
import { CopyButton } from "@/components/shared/copy-button";
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

type Phase =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done" }
  // Register answered 409: the email has an account, so the person pastes its key.
  | { kind: "email-taken" }
  // A fresh key that could not finish. agent-fs shows it once.
  | { kind: "new-key"; apiKey: string; message: string }
  | { kind: "failed"; message: string };

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
 * Files: create the person's agent-fs account with their step 1 email and
 * connect this browser to Comb. Runs Comb's own flow (`createAndConnect`)
 * once, with no click: register, invite to the swarm drive, save the key.
 */
export function StepFilesBody({ onboarding, act, setContinueBlocker }: StepProps) {
  const { state, endpoint, orgId, driveId, retry } = useAgentFs();
  const deps = useConnectFlowDeps();
  const { user } = useCurrentUser();
  const email = user?.email?.trim() || null;
  const stepDone = onboarding.state.steps.files.status === "done";
  const driveReady = orgId !== null && driveId !== null;

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [pasteKey, setPasteKey] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  // One run per endpoint and email: re-renders and strict mode must not register twice.
  const handled = useRef<string | null>(null);
  const runKey = endpoint && email ? `${endpoint}|${email}` : null;

  useContinueBlocker(
    setContinueBlocker,
    phase.kind === "running" ? "Creating your files account…" : null,
    { busy: phase.kind === "running" },
  );

  const complete = useCallback(
    async (method: FilesMethod) => {
      setPhase({ kind: "done" });
      try {
        await act({ action: "complete", step: "files", method });
      } catch (err) {
        // The account exists either way. A non-admin cannot write onboarding.
        if (!isForbidden(err)) console.warn("[setup] files step not saved", err);
      }
    },
    [act],
  );

  const settle = useCallback(
    async (outcome: ConnectOutcome, method: FilesMethod) => {
      if (outcome.kind === "connected") {
        await complete(method);
      } else if (outcome.kind === "email-taken") {
        setPhase({ kind: "email-taken" });
      } else if (outcome.newKey) {
        setPhase({ kind: "new-key", apiKey: outcome.newKey, message: outcome.message });
      } else {
        setPhase({ kind: "failed", message: outcome.message });
      }
    },
    [complete],
  );

  const create = useCallback(async () => {
    if (!deps || !email) return;
    setPhase({ kind: "running" });
    await settle(await createAndConnect(deps, email), "created");
  }, [deps, email, settle]);

  /** Retry with the key a fresh registration returned: the account is new. */
  async function retryNewKey(apiKey: string) {
    if (!deps) return;
    setPhase({ kind: "running" });
    const outcome = await connectWithKey(deps, apiKey);
    if (outcome.kind === "failed") setPhase({ kind: "new-key", apiKey, message: outcome.message });
    else await settle(outcome, "created");
  }

  async function onPaste(event: FormEvent) {
    event.preventDefault();
    const key = pasteKey.trim();
    if (!key || !deps) return;
    setPasteBusy(true);
    setPasteError(null);
    const outcome = await connectWithKey(deps, key);
    setPasteBusy(false);
    if (outcome.kind === "connected") await complete("connected");
    else if (outcome.kind === "failed") setPasteError(outcome.message);
  }

  useEffect(() => {
    if (state === "ready") {
      // Connected in this browser already (on entry, not after our own run): nothing to create.
      if (handled.current !== null || !endpoint) return;
      handled.current = `${endpoint}|ready`;
      if (stepDone) setPhase({ kind: "done" });
      else void complete("connected");
      return;
    }
    if (state !== "needs-connect" || !runKey || handled.current === runKey) return;
    // Also when the step is done: this browser has no key yet (another browser finished it).
    if (!deps || !driveReady) return;
    handled.current = runKey;
    void create();
  }, [runKey, endpoint, state, deps, driveReady, stepDone, complete, create]);

  // The step is done for the swarm, but this browser is connected only when agent-fs says ready.
  const done = phase.kind === "done" || (stepDone && phase.kind === "idle" && state === "ready");
  // A saved key agent-fs rejects means the account exists: paste its key, as Comb does.
  const pasting =
    phase.kind === "email-taken" || (phase.kind === "idle" && state === "invalid-key");
  // The picture explains the step. A state that needs the person's action shows alone.
  const showPreview =
    !pasting && phase.kind !== "new-key" && phase.kind !== "failed" && state !== "disabled";

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
          description={email ? `Connected as ${email}.` : "Files is connected in this browser."}
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
      ) : !email ? (
        <AlertCallout tone="info" icon={AlertCircle}>
          <p>
            Add your email in step 1 to create your files account.{" "}
            <Link to={setupStepHref("connect")} replace className="underline underline-offset-2">
              Go to step 1
            </Link>
          </p>
        </AlertCallout>
      ) : pasting ? (
        <SetupCard
          title={
            phase.kind === "email-taken"
              ? "This email already has an agent-fs account"
              : "agent-fs no longer accepts your saved key"
          }
          description="Paste its key to connect this browser."
        >
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
      ) : phase.kind === "new-key" ? (
        <SetupCard title="Save this key now. It is shown once.">
          <div className="relative rounded-md border border-border bg-muted/40 py-2 pr-10 pl-3 font-mono text-xs break-all">
            {phase.apiKey}
            <CopyButton value={phase.apiKey} ariaLabel="Copy key" />
          </div>
          <AlertCallout tone="error" icon={AlertCircle} className="mt-3">
            {phase.message}
          </AlertCallout>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void retryNewKey(phase.apiKey)}
          >
            <RotateCw />
            Retry
          </Button>
        </SetupCard>
      ) : phase.kind === "failed" ? (
        <AlertCallout tone="error" icon={AlertCircle} title="Could not create your files account">
          <p>{phase.message}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void create()}>
            <RotateCw />
            Retry
          </Button>
        </AlertCallout>
      ) : state === "unreachable" ? (
        <AlertCallout tone="error" icon={AlertCircle} title="Cannot reach agent-fs">
          <Button variant="outline" size="sm" className="mt-1" onClick={retry}>
            <RotateCw />
            Retry
          </Button>
        </AlertCallout>
      ) : state === "disabled" ? (
        <AlertCallout tone="warning" icon={AlertCircle}>
          Files is off on this swarm. Skip this step.
        </AlertCallout>
      ) : state === "needs-connect" && !driveReady ? (
        <AlertCallout tone="warning" icon={AlertCircle}>
          The swarm drive is not set up yet. Ask a swarm admin to check the agent-fs setup.
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
