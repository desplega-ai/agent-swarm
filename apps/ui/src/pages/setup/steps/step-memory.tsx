import { AlertCircle, Check, CheckCircle2, Info, Loader2, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useTestOnboardingMemory } from "@/api/hooks/use-onboarding";
import type {
  OnboardingErrorClass,
  OnboardingMemoryPreset,
  OnboardingMemoryTestRequest,
  OnboardingMemoryTestResponse,
} from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { cn } from "@/lib/utils";
import { BrandLogo, SetupCard, SetupChip, type SetupChipTone } from "../components/setup-card";
import type { StepProps } from "../step-contract";
import { SecretInput } from "./integrations/setup-field";

type ReuseKey = NonNullable<OnboardingMemoryTestRequest["reuseKey"]>;

interface Preset {
  id: Exclude<OnboardingMemoryPreset, "existing">;
  label: string;
  logo?: string;
  baseUrl: string;
  model: string;
  keyLabel: string;
  placeholder: string;
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
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    model: "",
    keyLabel: "API key",
    placeholder: "••••",
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

export function StepMemory({ onboarding }: StepProps) {
  const [preset, setPreset] = useState<Preset>(PRESETS[0]);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [model, setModel] = useState(preset.model);
  const [apiKey, setApiKey] = useState("");
  const [reuse, setReuse] = useState(false);
  const [result, setResult] = useState<OnboardingMemoryTestResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const test = useTestOnboardingMemory();
  const presenceQ = useEnvPresence(["OPENAI_API_KEY", "OPENROUTER_API_KEY"]);

  const { configured, dimensions } = onboarding.signals.embeddings;
  const stepStatus = onboarding.state.steps.memory.status;
  const reuseKey =
    preset.reuseKey && presenceQ.data?.[preset.reuseKey] ? preset.reuseKey : undefined;
  const usingReuse = reuse && reuseKey !== undefined;
  const testingExisting = test.isPending && test.variables?.preset === "existing";
  const testingCandidate = test.isPending && !testingExisting;
  const canTest =
    baseUrl.trim().length > 0 &&
    model.trim().length > 0 &&
    (usingReuse || apiKey.trim().length > 0) &&
    !test.isPending;

  function selectPreset(next: Preset) {
    setPreset(next);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
    setApiKey("");
    setReuse(false);
    setResult(null);
    setRequestError(null);
  }

  async function run(body: OnboardingMemoryTestRequest) {
    setResult(null);
    setRequestError(null);
    try {
      setResult(await test.mutateAsync(body));
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    }
  }

  function testAndSave() {
    void run({
      preset: preset.id,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(usingReuse ? { reuseKey } : { apiKey: apiKey.trim() }),
    });
  }

  const chip: { tone: SetupChipTone; label: string } =
    stepStatus === "done"
      ? { tone: "success", label: "Verified" }
      : stepStatus === "failed"
        ? { tone: "error", label: "Failed" }
        : stepStatus === "skipped"
          ? { tone: "neutral", label: "Skipped" }
          : { tone: "neutral", label: "Not tested" };

  return (
    <div className="space-y-3">
      <SetupCard
        title="Embeddings"
        status={<SetupChip tone={chip.tone}>{chip.label}</SetupChip>}
        bodyClassName="space-y-4"
      >
        {configured ? (
          <AlertCallout tone="info" icon={Info}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Memory is already configured on the server.</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={test.isPending}
                onClick={() => void run({ preset: "existing" })}
              >
                {testingExisting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Test current setup
              </Button>
            </div>
          </AlertCallout>
        ) : null}

        <div className="space-y-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Provider preset
          </span>
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
          <p className="text-xs text-muted-foreground">
            Any OpenAI-compatible embeddings endpoint works.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SettingsRow label="Base URL" htmlFor="memory-base-url">
            <Input
              id="memory-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://embeddings.example.com/v1"
              spellCheck={false}
              className="font-mono"
            />
          </SettingsRow>
          <SettingsRow label="Model" htmlFor="memory-model">
            <Input
              id="memory-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
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
            reuseKey ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
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
            ) : undefined
          }
        >
          <SecretInput
            id="memory-api-key"
            value={usingReuse ? "" : apiKey}
            onChange={setApiKey}
            placeholder={usingReuse ? "Using the key from step 3" : preset.placeholder}
            disabled={usingReuse}
          />
        </SettingsRow>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={testAndSave} disabled={!canTest}>
            {testingCandidate ? <Loader2 className="size-4 animate-spin" /> : null}
            Test and save
          </Button>
          <span className="text-xs text-muted-foreground">One vector, then it is discarded.</span>
        </div>

        {result?.ok ? (
          <AlertCallout tone="success" icon={CheckCircle2}>
            Embeddings work. {result.dimensions ?? dimensions} dims, {result.latencyMs} ms.
          </AlertCallout>
        ) : null}
        {result && !result.ok ? (
          <AlertCallout
            tone="error"
            icon={AlertCircle}
            title={result.error ? errorHint(result.errorClass, dimensions) : undefined}
          >
            {result.error ? (
              <span className="break-all font-mono text-muted-foreground">{result.error}</span>
            ) : (
              errorHint(result.errorClass, dimensions)
            )}
          </AlertCallout>
        ) : null}
        {requestError ? (
          <AlertCallout tone="error" icon={AlertCircle} title="Could not run the test.">
            <span className="break-all font-mono text-muted-foreground">{requestError}</span>
          </AlertCallout>
        ) : null}
      </SetupCard>

      <div className="space-y-1 px-0.5 text-xs text-muted-foreground">
        <p>Vectors are stored at {dimensions} dimensions.</p>
        <p>Memory stays off if you skip. Agents will not remember across tasks.</p>
      </div>
    </div>
  );
}
