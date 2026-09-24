import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RotateCw } from "lucide-react";
import { type ComponentType, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import {
  isOnboardingFinished,
  ONBOARDING_QUERY_KEY,
  ONBOARDING_STEPS,
  onboardingResumeStep,
  useOnboarding,
  useOnboardingAction,
} from "@/api/hooks/use-onboarding";
import type { OnboardingResponse, OnboardingStepId, OnboardingStepStatus } from "@/api/types";
import { markSetupVisited } from "@/components/onboarding/onboarding-redirect";
import { stepNumber } from "@/components/onboarding/step-status";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { HiveLoadingScreen } from "@/components/shared/hive-loading-screen";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/hooks/use-config";
import { cn } from "@/lib/utils";
import { SetupFooter } from "./components/setup-footer";
import { SETUP_COLUMN } from "./components/setup-layout";
import { SetupStepper } from "./components/setup-stepper";
import { SetupTopBar } from "./components/setup-top-bar";
import { StepTransition } from "./components/step-transition";
import type { StepProps } from "./step-contract";
import { StepAi } from "./steps/step-ai";
import { StepConnect } from "./steps/step-connect";
import { StepFirstTask } from "./steps/step-first-task";
import { StepIntegrations } from "./steps/step-integrations";
import { StepMemory } from "./steps/step-memory";
import { StepName } from "./steps/step-name";

const STEP_COPY: Record<OnboardingStepId, { title: string; description: string }> = {
  connect: {
    title: "Connect your swarm",
    description: "Point this dashboard at your Agent Swarm API, then pick who you are.",
  },
  name: {
    title: "Give your swarm an identity",
    description: "The name, mark, and color your team sees in the sidebar, in Slack, and on pages.",
  },
  ai: {
    title: "Pick an AI provider",
    description: "One verified provider is enough to start.",
  },
  memory: {
    title: "Turn on memory",
    description: "Embeddings let agents recall earlier work.",
  },
  integrations: {
    title: "Connect your tools",
    description: "All optional. Connect what your team already uses.",
  },
  first_task: {
    title: "Run your first task",
    description: "Send your lead a first message. Setup is done when that task completes.",
  },
};

/** Skip tooltips that say what skipping costs. */
const SKIP_HINT: Partial<Record<OnboardingStepId, string>> = {
  memory: "Memory stays off until you set it up.",
};

const STEP_BODIES: Record<Exclude<OnboardingStepId, "connect">, ComponentType<StepProps>> = {
  name: StepName,
  ai: StepAi,
  memory: StepMemory,
  integrations: StepIntegrations,
  first_task: StepFirstTask,
};

const TOTAL = ONBOARDING_STEPS.length;

/** `?step=` accepts a number (1-6) or a step id. */
function parseStepParam(value: string | null): OnboardingStepId | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= TOTAL) return ONBOARDING_STEPS[n - 1].id;
  return ONBOARDING_STEPS.find((step) => step.id === value)?.id ?? null;
}

/** Where to land after connecting: the page the layout sent us from, never `/setup` itself. */
function resolveFrom(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("/setup")) return "/";
  return from;
}

function stepStatuses(
  data: OnboardingResponse | null | undefined,
): Record<OnboardingStepId, OnboardingStepStatus> {
  return Object.fromEntries(
    ONBOARDING_STEPS.map(({ id }) => [id, data ? data.state.steps[id].status : "todo"]),
  ) as Record<OnboardingStepId, OnboardingStepStatus>;
}

/**
 * A blocker that ends with an ellipsis ("Saving…", "Testing…") reports work in
 * flight: the footer shows a spinner for it. Any other blocker asks for input.
 */
function isInFlight(reason: string): boolean {
  return reason.endsWith("…") || reason.endsWith("...");
}

/** Why Continue is disabled for a step that is neither done nor skipped. */
function unsettledReason(step: OnboardingStepId, status: OnboardingStepStatus): string {
  if (step === "connect") return "Connect to your API first.";
  if (status === "failed") return "Last check failed. Retry or skip.";
  return "Finish this step or skip it.";
}

type BlockerSetter = StepProps["setContinueBlocker"];

/**
 * Continue blockers, one slot per step, cleared on every step change. A step
 * gets a stable setter bound to its own slot, so a step still animating out
 * can never block the step that replaced it.
 */
function useContinueBlockers(stepId: OnboardingStepId) {
  const [state, setState] = useState<{
    step: OnboardingStepId;
    reasons: Partial<Record<OnboardingStepId, string>>;
  }>({ step: stepId, reasons: {} });
  // Reset during render (not in an effect): child effects run before parent
  // effects, so an effect here would wipe what the new step just set.
  if (state.step !== stepId) setState({ step: stepId, reasons: {} });

  const setters = useMemo(
    () =>
      Object.fromEntries(
        ONBOARDING_STEPS.map(({ id }) => [
          id,
          (reason: string | null) =>
            setState((prev) => {
              if ((prev.reasons[id] ?? null) === reason) return prev;
              const reasons = { ...prev.reasons };
              if (reason === null) delete reasons[id];
              else reasons[id] = reason;
              return { ...prev, reasons };
            }),
        ]),
      ) as Record<OnboardingStepId, BlockerSetter>,
    [],
  );

  return { blocker: state.step === stepId ? (state.reasons[stepId] ?? null) : null, setters };
}

/** +1 when the step index grows (Next), -1 when it shrinks (Back). */
function useStepDirection(index: number): 1 | -1 {
  const [nav, setNav] = useState<{ index: number; direction: 1 | -1 }>({ index, direction: 1 });
  // Render-phase update: React re-renders with the new direction before it commits.
  if (nav.index !== index) setNav({ index, direction: index > nav.index ? 1 : -1 });
  return nav.direction;
}

/** First-run onboarding: a full page outside the app shell (no sidebar, no header). */
export default function SetupPage() {
  const { pendingConnection } = useConfig();
  // A connection from URL params is not stored yet, and the API client only
  // reads stored connections. The shell's `NameConnectionModal` stores it.
  if (pendingConnection) return <Navigate to="/" replace />;
  return (
    <ErrorBoundary>
      <SetupFlow />
    </ErrorBoundary>
  );
}

function SetupFlow() {
  const { config, isConfigured } = useConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  // Captured once: `?step=` syncs replace the history entry and drop its state.
  const [from] = useState(() => resolveFrom(location.state));
  const [mountedAt] = useState(Date.now);
  const query = useOnboarding({ refetchInterval: 5000, enabled: isConfigured });
  const { mutateAsync: act } = useOnboardingAction();
  const [busy, setBusy] = useState(false);

  // Before a connection exists only step 1 renders, whatever the cache holds.
  const data = isConfigured ? query.data : undefined;
  const fresh = query.dataUpdatedAt >= mountedAt;
  const paramStep = parseStepParam(searchParams.get("step"));
  const stepId: OnboardingStepId = !isConfigured
    ? "connect"
    : (paramStep ?? (data ? onboardingResumeStep(data.state) : "connect"));
  const index = stepNumber(stepId);
  const stepParam = String(index);
  const currentStep = data?.state.currentStep;
  const { blocker, setters: blockerSetters } = useContinueBlockers(stepId);
  const direction = useStepDirection(index);

  // Only the content region scrolls: a new step starts at its top.
  const mainRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on step change only
  useLayoutEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [stepId]);

  useEffect(() => {
    markSetupVisited(config.apiUrl);
  }, [config.apiUrl]);

  // Keep `?step=N` in the URL once the payload decides the step.
  useEffect(() => {
    if (!data || searchParams.get("step") === stepParam) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("step", stepParam);
        return next;
      },
      { replace: true },
    );
  }, [data, searchParams, setSearchParams, stepParam]);

  // Opening setup on purpose resumes it. Decide once, on a payload fetched
  // after mount (a persisted cache can still say "minimized").
  const resumeChecked = useRef(false);
  useEffect(() => {
    if (!data || !fresh || resumeChecked.current) return;
    resumeChecked.current = true;
    if (data.state.minimizedAt || data.state.dismissedAt) {
      act({ action: "resume" }).catch(() => {});
    }
  }, [data, fresh, act]);

  // Record the step on screen when it differs from the stored one, once per step.
  const viewed = useRef<OnboardingStepId | null>(null);
  useEffect(() => {
    if (!currentStep || currentStep === stepId || viewed.current === stepId) return;
    viewed.current = stepId;
    act({ action: "view", step: stepId }).catch(() => {});
  }, [currentStep, stepId, act]);

  function goTo(step: OnboardingStepId) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("step", String(stepNumber(step)));
        return next;
      },
      { replace: true },
    );
  }

  async function leave() {
    // Minimizing must not look like "opened while minimized" to the resume check.
    resumeChecked.current = true;
    setBusy(true);
    if (data && !isOnboardingFinished(data.state)) {
      try {
        await act({ action: "minimize" });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not minimize setup");
      }
    }
    void navigate("/");
  }

  function goNext() {
    const next = ONBOARDING_STEPS[stepNumber(stepId)];
    if (next) goTo(next.id);
    else void leave();
  }

  async function skip(step: Exclude<OnboardingStepId, "connect">) {
    setBusy(true);
    try {
      await act({ action: "skip", step });
      goNext();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not skip this step");
    } finally {
      setBusy(false);
    }
  }

  async function handleConnected() {
    let next: OnboardingResponse | null;
    try {
      next = await queryClient.fetchQuery({
        queryKey: ONBOARDING_QUERY_KEY,
        queryFn: () => api.fetchOnboarding(),
        staleTime: 0,
      });
    } catch {
      return; // The configured view shows the error and a way to fix the connection.
    }
    if (!next || isOnboardingFinished(next.state)) {
      void navigate(from, { replace: true });
      return;
    }
    goTo(onboardingResumeStep(next.state));
  }

  if (isConfigured) {
    if (query.isError && !data) {
      return <SetupError message={query.error.message} onRetry={() => void query.refetch()} />;
    }
    // A cached `null` (older API) must not bounce the operator: wait for a fresh answer.
    if (data === undefined || (data === null && !fresh)) return <FullPageLoading />;
    if (data === null) return <Navigate to={from} replace />;
  }

  const statuses = stepStatuses(data);
  const status = statuses[stepId];
  const finished = data ? isOnboardingFinished(data.state) : false;
  const copy = STEP_COPY[stepId];
  const Body = stepId === "connect" ? null : STEP_BODIES[stepId];
  const settled = status === "done" || status === "skipped";
  const primary =
    data && (stepId === "first_task" || finished)
      ? { label: "Go to dashboard", blockedBy: null, onClick: () => void leave() }
      : {
          label: "Continue",
          blockedBy: blocker ?? (settled ? null : unsettledReason(stepId, status)),
          onClick: goNext,
        };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <SetupTopBar
        configured={isConfigured}
        stepper={
          <SetupStepper statuses={statuses} current={stepId} onSelect={data ? goTo : undefined} />
        }
        onMinimize={data ? () => void leave() : undefined}
        minimizing={busy}
      />

      <main
        ref={mainRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges]"
      >
        <div className={cn(SETUP_COLUMN, "pt-8 pb-12 sm:pt-10")}>
          <StepTransition stepKey={stepId} direction={direction}>
            <p className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-primary">
              Step {index} <span className="text-muted-foreground">of {TOTAL}</span>
            </p>
            <h1 className="mb-1.5 text-xl font-semibold tracking-tight text-balance sm:text-2xl">
              {copy.title}
            </h1>
            <p className="mb-6 max-w-[70ch] text-sm text-muted-foreground">{copy.description}</p>
            {Body === null ? (
              <StepConnect
                onboarding={data ?? null}
                onConnected={() => void handleConnected()}
                act={data ? act : undefined}
                setContinueBlocker={blockerSetters.connect}
              />
            ) : data ? (
              // A failing step must not take the shell (navigation, Minimize) down with it.
              <ErrorBoundary key={stepId}>
                <Body
                  onboarding={data}
                  act={act}
                  goNext={goNext}
                  setContinueBlocker={blockerSetters[stepId]}
                />
              </ErrorBoundary>
            ) : null}
          </StepTransition>
        </div>
      </main>

      <SetupFooter
        status={data ? status : null}
        pending={busy ? "Working…" : blocker && isInFlight(blocker) ? blocker : null}
        busy={busy}
        onBack={index > 1 && data ? () => goTo(ONBOARDING_STEPS[index - 2].id) : undefined}
        skip={
          data && stepId !== "connect"
            ? {
                label: status === "skipped" ? "Skipped" : "Skip",
                disabled: status === "done" || status === "skipped",
                onSkip: () => void skip(stepId),
                hint: SKIP_HINT[stepId],
              }
            : undefined
        }
        primary={primary}
      />
    </div>
  );
}

function FullPageLoading() {
  return (
    <div className="flex min-h-svh bg-background">
      <HiveLoadingScreen />
    </div>
  );
}

function SetupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <AlertCallout
        tone="error"
        icon={AlertTriangle}
        title="Could not load setup"
        className="w-full max-w-md"
      >
        <p>
          {message}. Check the API URL and key in{" "}
          {/* A new tab: this one keeps its place and retries once the connection is fixed. */}
          <Link
            to="/settings/connections"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            Settings, Connections
          </Link>
          .
        </p>
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-3">
          <RotateCw />
          Retry
        </Button>
      </AlertCallout>
    </div>
  );
}
