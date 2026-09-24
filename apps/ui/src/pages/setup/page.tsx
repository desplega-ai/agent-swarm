import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { type ComponentType, Suspense, useEffect, useRef, useState } from "react";
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
import { useConfig } from "@/hooks/use-config";
import { SetupFooter } from "./components/setup-footer";
import { SetupProgress } from "./components/setup-progress";
import { SetupTopBar } from "./components/setup-top-bar";
import type { StepProps } from "./step-contract";
import { StepAi } from "./steps/step-ai";
import { StepConnect } from "./steps/step-connect";
import { StepFirstTask } from "./steps/step-first-task";
import { StepIntegrations } from "./steps/step-integrations";
import { StepMemory } from "./steps/step-memory";
import { StepName } from "./steps/step-name";

const STEP_COPY: Record<OnboardingStepId, { title: string; description: string }> = {
  connect: {
    title: "Connect to your API server",
    description:
      "Point this dashboard at a running Agent Swarm API. The check probes /health, so a green result means the server really answered.",
  },
  name: {
    title: "Name your swarm",
    description: "The name and mark used in the sidebar, in Slack, and on shared pages.",
  },
  ai: {
    title: "Pick an AI provider",
    description: "One verified provider is enough to start. Workers check each key you save.",
  },
  memory: {
    title: "Turn on memory",
    description: "Embeddings let agents recall earlier work. Any OpenAI-compatible endpoint works.",
  },
  integrations: {
    title: "Connect your tools",
    description: "All optional. Connect what your team already uses, or skip and do it later.",
  },
  first_task: {
    title: "Run your first task",
    description:
      "Wait for the lead, then send your first message. Setup is done when that task completes.",
  },
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

function footerNote(step: OnboardingStepId, status: OnboardingStepStatus): string {
  if (status === "done") return "This step is verified.";
  if (status === "skipped") return "Skipped. You can come back to it.";
  if (status === "failed") return "The last check failed. Try again or skip.";
  if (step === "memory") return "Skipping leaves memory off.";
  return "Nothing is saved until a check passes.";
}

/** First-run onboarding: a full page outside the app shell (no sidebar, no header). */
export default function SetupPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<FullPageLoading />}>
        <SetupFlow />
      </Suspense>
    </ErrorBoundary>
  );
}

function SetupFlow() {
  const { isConfigured } = useConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  // Captured once: `?step=` syncs replace the history entry and drop its state.
  const [from] = useState(() => resolveFrom(location.state));
  const [mountedAt] = useState(Date.now);
  const query = useOnboarding({ pollIntervalMs: 5000, enabled: isConfigured });
  const { mutateAsync: act } = useOnboardingAction();
  const [busy, setBusy] = useState(false);

  // Before a connection exists only step 1 renders, whatever the cache holds.
  const data = isConfigured ? query.data : undefined;
  const fresh = query.dataUpdatedAt >= mountedAt;
  const paramStep = parseStepParam(searchParams.get("step"));
  const stepId: OnboardingStepId = !isConfigured
    ? "connect"
    : (paramStep ?? (data ? onboardingResumeStep(data.state) : "connect"));
  const stepParam = String(stepNumber(stepId));
  const currentStep = data?.state.currentStep;

  useEffect(() => {
    markSetupVisited();
  }, []);

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
    window.scrollTo({ top: 0 });
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
    if (query.isError && !data) return <SetupError message={query.error.message} />;
    // A cached `null` (older API) must not bounce the operator: wait for a fresh answer.
    if (data === undefined || (data === null && !fresh)) return <FullPageLoading />;
    if (data === null) return <Navigate to={from} replace />;
  }

  const statuses = stepStatuses(data);
  const status = statuses[stepId];
  const index = stepNumber(stepId);
  const finished = data ? isOnboardingFinished(data.state) : false;
  const copy = STEP_COPY[stepId];
  const Body = stepId === "connect" ? null : STEP_BODIES[stepId];
  const primary =
    data && (stepId === "first_task" || finished)
      ? { label: "Go to dashboard", disabled: false, onClick: () => void leave() }
      : { label: "Continue", disabled: status !== "done" && status !== "skipped", onClick: goNext };

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <SetupTopBar
        configured={isConfigured}
        onMinimize={data ? () => void leave() : undefined}
        minimizing={busy}
      />
      <SetupProgress statuses={statuses} current={stepId} onSelect={data ? goTo : undefined} />

      <main className="flex flex-1 flex-col px-3 pt-4 pb-8 sm:px-5">
        <div className="mx-auto my-auto w-full max-w-[800px]">
          <p className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-primary">
            Step {index} <span className="text-muted-foreground">of {TOTAL}</span>
          </p>
          <h1 className="mb-1.5 text-xl font-semibold tracking-tight text-balance sm:text-2xl">
            {copy.title}
          </h1>
          <p className="mb-4 max-w-[70ch] text-sm text-muted-foreground">{copy.description}</p>
          {Body === null ? (
            <StepConnect
              onboarding={data ?? null}
              onConnected={() => void handleConnected()}
              act={data ? act : undefined}
            />
          ) : data ? (
            // A failing step must not take the shell (navigation, Minimize) down with it.
            <ErrorBoundary key={stepId}>
              <Body onboarding={data} act={act} goNext={goNext} />
            </ErrorBoundary>
          ) : null}
        </div>
      </main>

      <SetupFooter
        note={footerNote(stepId, status)}
        busy={busy}
        onBack={index > 1 && data ? () => goTo(ONBOARDING_STEPS[index - 2].id) : undefined}
        skip={
          data && stepId !== "connect"
            ? {
                label: status === "skipped" ? "Skipped" : "Skip",
                disabled: status === "done" || status === "skipped",
                onSkip: () => void skip(stepId),
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

function SetupError({ message }: { message: string }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <AlertCallout
        tone="error"
        icon={AlertTriangle}
        title="Could not load setup"
        className="w-full max-w-md"
      >
        {message}. Check the API URL and key in{" "}
        <Link to="/settings/connections" className="underline underline-offset-2">
          Settings, Connections
        </Link>
        .
      </AlertCallout>
    </div>
  );
}
