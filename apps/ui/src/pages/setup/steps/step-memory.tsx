import { Check, Loader2, RotateCw, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useTestOnboardingMemory } from "@/api/hooks/use-onboarding";
import type {
  OnboardingErrorClass,
  OnboardingMemoryPreset,
  OnboardingMemoryTestRequest,
  OnboardingMemoryTestResponse,
} from "@/api/types";
import { FadeIn } from "@/components/onboarding/fade-in";
import { SetupCard } from "@/components/onboarding/setup-card";
import {
  AutosaveScopeContext,
  useAutosave,
  useAutosaveScope,
} from "@/components/onboarding/use-autosave";
import { BrandLogo } from "@/components/shared/brand-logo";
import {
  checkSecret,
  KEY_RULES,
  SecretInput,
  type SecretRule,
  usePasteCommit,
} from "@/components/shared/secret-field";
import { StatusIcon, StatusLine, type StatusTone } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { StepProps } from "../step-contract";
import { baseUrlError } from "./ai/model";

type ReuseKey = NonNullable<OnboardingMemoryTestRequest["reuseKey"]>;

interface Preset {
  id: Exclude<OnboardingMemoryPreset, "existing">;
  label: string;
  logo?: string;
  baseUrl: string;
  model: string;
  keyLabel: string;
  placeholder: string;
  keyRule: SecretRule;
  /** Step 3 key this preset can reuse, when the server has it. */
  reuseKey?: ReuseKey;
}

// R6: no Ollama preset. The stored vector size is fixed (EMBEDDING_DIMENSIONS).
const PRESETS: Preset[] = [
  {
    id: "openai",
    label: "OpenAI",
    logo: "/provider-logos/openai.svg",
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    keyLabel: "OpenAI API key",
    placeholder: "sk-proj-...",
    keyRule: KEY_RULES.openAi,
    reuseKey: "OPENAI_API_KEY",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    logo: "/provider-logos/openrouter.svg",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/text-embedding-3-small",
    keyLabel: "OpenRouter API key",
    placeholder: "sk-or-v1-...",
    keyRule: KEY_RULES.openRouter,
    reuseKey: "OPENROUTER_API_KEY",
  },
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    logo: "/integration-logos/vercel.svg",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    model: "openai/text-embedding-3-small",
    keyLabel: "AI Gateway API key",
    placeholder: "vck_...",
    keyRule: KEY_RULES.vercel,
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    model: "",
    keyLabel: "API key",
    placeholder: "••••",
    // Unknown format: 16+ characters.
    keyRule: {},
  },
];

function errorHint(errorClass: OnboardingErrorClass | undefined, dims: number): string {
  switch (errorClass) {
    case "auth":
      return "The key was rejected.";
    case "model":
      return "The model was not found at this endpoint.";
    case "dimension":
      return `The endpoint returned vectors of the wrong size. Memory stores ${dims} dims.`;
    case "network":
    case "timeout":
      return "Could not reach the endpoint.";
    default:
      return "The embedding call failed.";
  }
}

/** An outcome belongs to the candidate it tested (the JSON of its request). */
type Outcome = { candidate: string } & (
  | { kind: "result"; result: OnboardingMemoryTestResponse }
  | { kind: "request-error"; message: string }
);

/** "Test current setup" tests the stored config, not the fields. */
const EXISTING_CANDIDATE = JSON.stringify({ preset: "existing" });

/** The endpoint could not be reached: the same setup can work on a second try. */
const RETRYABLE_CLASSES: ReadonlySet<OnboardingErrorClass> = new Set(["network", "timeout"]);

function isRetryable(outcome: Outcome): boolean {
  if (outcome.kind === "request-error") return true;
  const { errorClass } = outcome.result;
  return !outcome.result.ok && errorClass !== undefined && RETRYABLE_CLASSES.has(errorClass);
}

/**
 * Step 4: embeddings. No Save button: once the fields are valid, the step
 * runs the test-and-save probe by itself (one embedding call; the API stores
 * the config only when it works). A typed key tests on paste or blur only,
 * never half-typed. A result shows only while the fields still match it.
 */
export function StepMemory({ onboarding, setContinueBlocker }: StepProps) {
  const scope = useAutosaveScope(setContinueBlocker);
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [model, setModel] = useState(preset.model);
  const [apiKey, setApiKey] = useState("");
  const [reuse, setReuse] = useState(false);
  const [keyBlurred, setKeyBlurred] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const test = useTestOnboardingMemory();
  const presenceQ = useEnvPresence(["OPENAI_API_KEY", "OPENROUTER_API_KEY"]);

  const { configured, dimensions } = onboarding.signals.embeddings;
  const stepStatus = onboarding.state.steps.memory.status;
  const reuseKey =
    preset.reuseKey && presenceQ.data?.[preset.reuseKey] ? preset.reuseKey : undefined;
  const usingReuse = reuse && reuseKey !== undefined;

  const url = baseUrl.trim();
  const modelId = model.trim();
  const key = apiKey.trim();
  const urlError = url ? baseUrlError(url) : null;
  const keyCheck = checkSecret(key, preset.keyRule);
  const keyProblem =
    keyCheck.problem && (keyBlurred || keyCheck.problemNow) ? keyCheck.problem : null;
  const fieldsOk = url.length > 0 && !urlError && modelId.length > 0;

  const body: OnboardingMemoryTestRequest = {
    preset: preset.id,
    baseUrl: url,
    model: modelId,
    ...(usingReuse ? { reuseKey } : { apiKey: key }),
  };
  // Stable identity of the candidate: the probe runs once per distinct setup.
  const candidate = JSON.stringify(body);

  /**
   * Test one request and keep its outcome. Throws when the same setup can
   * work on a retry (the request failed, or the endpoint was unreachable),
   * so the autosave keeps it retryable.
   */
  async function run(request: OnboardingMemoryTestRequest) {
    const tested = JSON.stringify(request);
    let next: Outcome;
    try {
      next = { candidate: tested, kind: "result", result: await test.mutateAsync(request) };
    } catch (err) {
      next = {
        candidate: tested,
        kind: "request-error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    setOutcome(next);
    if (isRetryable(next)) {
      throw new Error(
        next.kind === "request-error"
          ? next.message
          : errorHint(next.result.errorClass, dimensions),
      );
    }
  }

  const probe = useAutosave({
    value: candidate,
    dirty: fieldsOk && (usingReuse || key.length > 0),
    // Without a typed key nothing is half-typed: test after the debounce.
    ready: fieldsOk && usingReuse,
    readyOnCommit: fieldsOk && (usingReuse || keyCheck.valid),
    save: (value) => run(JSON.parse(value) as OnboardingMemoryTestRequest),
  });

  const paste = usePasteCommit(probe.commit);

  function selectPreset(next: Preset) {
    setPreset(next);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setApiKey("");
    setReuse(false);
    setKeyBlurred(false);
    setOutcome(null);
  }

  // Only what belongs to the fields on screen: a probe still running for an
  // old preset, or its late result, never shows here.
  const running = test.isPending ? JSON.stringify(test.variables) : null;
  const testingExisting = running === EXISTING_CANDIDATE;
  const probing = running === candidate;
  const shown =
    outcome && (outcome.candidate === candidate || outcome.candidate === EXISTING_CANDIDATE)
      ? outcome
      : null;
  const result = shown?.kind === "result" ? shown.result : null;

  function retry() {
    if (shown?.candidate === EXISTING_CANDIDATE)
      void run({ preset: "existing" }).catch(() => undefined);
    else probe.commit();
  }

  const header: { tone: StatusTone; label: string } = probing
    ? { tone: "busy", label: "Testing the endpoint…" }
    : probe.phase === "pending"
      ? { tone: "dirty", label: "Tests when you stop typing" }
      : result && !result.ok
        ? { tone: "error", label: errorHint(result.errorClass, dimensions) }
        : shown?.kind === "request-error"
          ? { tone: "error", label: "Could not run the test." }
          : stepStatus === "done" || result?.ok
            ? { tone: "done", label: "Memory works" }
            : { tone: "none", label: "" };

  return (
    <AutosaveScopeContext.Provider value={scope}>
      <SetupCard
        title={
          <span className="flex items-center gap-1.5">
            Embeddings
            <InfoTip
              content={`Vectors are stored at ${dimensions} dimensions. The test sends one embedding, then discards it.`}
            />
          </span>
        }
        status={<StatusIcon tone={header.tone} label={header.label} />}
        bodyClassName="space-y-4"
      >
        {configured ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-2">
            <span className="text-sm">Memory is already set up on the server.</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={test.isPending}
              onClick={() => void run({ preset: "existing" }).catch(() => undefined)}
            >
              {testingExisting ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Test current setup
            </Button>
          </div>
        ) : null}

        <div role="radiogroup" aria-label="Provider preset" className="flex flex-wrap gap-2">
          {PRESETS.map((p) => {
            const active = p.id === preset.id;
            return (
              <Button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                variant="outline"
                size="sm"
                onClick={() => selectPreset(p)}
                className={cn(
                  active &&
                    "border-primary/60 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary",
                )}
              >
                {p.logo ? (
                  <BrandLogo src={p.logo} className="size-4" />
                ) : (
                  <SlidersHorizontal className="size-4" />
                )}
                {p.label}
              </Button>
            );
          })}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SettingsRow
            label="Base URL"
            htmlFor="memory-base-url"
            helper={
              urlError ? <span className="text-status-error-strong">{urlError}</span> : undefined
            }
          >
            <Input
              id="memory-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={probe.commit}
              placeholder="https://embeddings.example.com/v1"
              spellCheck={false}
              aria-invalid={urlError ? true : undefined}
              className="font-mono"
            />
          </SettingsRow>
          <SettingsRow label="Model" htmlFor="memory-model">
            <Input
              id="memory-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={probe.commit}
              placeholder="text-embedding-3-small"
              spellCheck={false}
              className="font-mono"
            />
          </SettingsRow>
        </div>

        <SettingsRow
          label={preset.keyLabel}
          htmlFor="memory-api-key"
          helper={
            keyProblem ? (
              <span className="text-status-error-strong">{keyProblem}</span>
            ) : shown || probing ? undefined : (
              "Paste the key, or type it and leave the field, to test and save it."
            )
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-60">
              <SecretInput
                id="memory-api-key"
                value={usingReuse ? "" : apiKey}
                onChange={(next) => {
                  paste.afterChange(apiKey, next);
                  setApiKey(next);
                }}
                onBlur={() => {
                  setKeyBlurred(true);
                  probe.commit();
                }}
                onPaste={paste.onPaste}
                placeholder={usingReuse ? "Using the key from step 3" : preset.placeholder}
                disabled={usingReuse}
                invalid={Boolean(keyProblem)}
              />
            </div>
            {reuseKey ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={usingReuse}
                onClick={() => setReuse((v) => !v)}
                className={cn(
                  usingReuse &&
                    "border-primary/60 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary",
                )}
              >
                {usingReuse ? <Check /> : null}
                Reuse key from step 3
              </Button>
            ) : null}
          </div>
        </SettingsRow>

        <ProbeResult
          probing={probing}
          outcome={shown}
          dimensions={dimensions}
          onRetry={shown && isRetryable(shown) && !test.isPending ? retry : undefined}
        />
      </SetupCard>
    </AutosaveScopeContext.Provider>
  );
}

/** Test again: for failures where the same setup can work on a second try. */
function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRetry}
          aria-label="Test again"
          className="text-muted-foreground"
        >
          <RotateCw />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Test again</TooltipContent>
    </Tooltip>
  );
}

/** One line under the fields: the probe running, then its result. */
function ProbeResult({
  probing,
  outcome,
  dimensions,
  onRetry,
}: {
  probing: boolean;
  outcome: Outcome | null;
  dimensions: number;
  /** Present when the failure can be retried as is. */
  onRetry?: () => void;
}) {
  if (probing) {
    return <StatusLine tone="busy">Testing the endpoint</StatusLine>;
  }
  if (!outcome) return null;
  const retry = onRetry ? <RetryButton onRetry={onRetry} /> : null;
  if (outcome.kind === "request-error") {
    return (
      <FadeIn key="request-error" className="flex items-center gap-1">
        <StatusLine tone="error">
          Could not run the test.{" "}
          <span className="break-all font-mono text-xs text-muted-foreground">
            {outcome.message}
          </span>
        </StatusLine>
        {retry}
      </FadeIn>
    );
  }
  const { result } = outcome;
  if (result.ok) {
    return (
      <FadeIn key="ok">
        <StatusLine tone="done">
          Memory works.{" "}
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {result.dimensions ?? dimensions} dims, {result.latencyMs} ms
          </span>
        </StatusLine>
      </FadeIn>
    );
  }
  return (
    <FadeIn key="fail">
      <div className="space-y-1">
        <span className="flex items-center gap-1">
          <StatusLine tone="error">{errorHint(result.errorClass, dimensions)}</StatusLine>
          {retry}
        </span>
        {result.error ? (
          <p className="break-all pl-6 font-mono text-xs text-muted-foreground">{result.error}</p>
        ) : null}
      </div>
    </FadeIn>
  );
}
