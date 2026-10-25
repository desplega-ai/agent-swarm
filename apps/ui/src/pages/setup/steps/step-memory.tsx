import { Check, RotateCw, SlidersHorizontal, TextCursorInput, TextSearch } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { type EnvPresenceMap, useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useTestOnboardingMemory } from "@/api/hooks/use-onboarding";
import type {
  OnboardingErrorClass,
  OnboardingMemoryPreset,
  OnboardingMemoryTestRequest,
  OnboardingMemoryTestResponse,
} from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import {
  checkSecret,
  KEY_RULES,
  type SecretRule,
  usePasteCommit,
} from "@/components/onboarding/autosave-secret-field";
import { setupExitHref } from "@/components/onboarding/onboarding-redirect";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { BrandLogo } from "@/components/shared/brand-logo";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { FadeIn } from "@/components/shared/fade-in";
import { ModelLogo } from "@/components/shared/model-logo";
import { SecretInput } from "@/components/shared/secret-input";
import { SetupCard } from "@/components/shared/setup-card";
import { SetupChip } from "@/components/shared/setup-chip";
import { StatusIcon, StatusLine, type StatusTone } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AutosaveScopeContext,
  type ContinueActionSetter,
  type ContinueBlockerSetter,
  useAutosave,
  useAutosaveScope,
  useContinueAction,
} from "@/hooks/use-autosave";
import { azureBaseUrl, azurePathHint } from "@/lib/azure-embeddings";
import { modelDisplayName } from "@/lib/model-vendor";
import { cn } from "@/lib/utils";
import type { StepProps } from "../step-contract";
import { baseUrlError } from "./ai/model";
import { ExternalTextLink } from "./integrations/pane-parts";

type ReuseKey = NonNullable<OnboardingMemoryTestRequest["reuseKey"]>;

/** Step 3 keys a preset can reuse. */
const REUSE_KEYS: ReuseKey[] = ["OPENAI_API_KEY", "OPENROUTER_API_KEY"];

/** A model chip. The first one of a preset is the recommended default. */
interface ModelChoice {
  /** The id the endpoint takes. */
  id: string;
  /** One line: what it trades against the recommended model. */
  tradeoff: string;
}

// Price ratios use official list prices per 1M tokens: text-embedding-3-small
// $0.02, text-embedding-3-large $0.13 (OpenAI), gemini-embedding-2 $0.20
// (Google), gemini-embedding-001 $0.15 (Vercel AI Gateway catalog).
const SMALL_TRADEOFF = "Cheapest, and faster than the large model.";
const LARGE_TRADEOFF = "Higher quality, slower, 6.5x the price of the recommended model.";

interface Preset {
  id: Exclude<OnboardingMemoryPreset, "existing">;
  label: string;
  logo?: string;
  baseUrl: string;
  /**
   * Only models documented to honor the `dimensions` parameter on this
   * endpoint. Empty: a free-text model field only.
   */
  models: ModelChoice[];
  keyLabel: string;
  /** Where to create a key. Absent: keys are per resource or per endpoint. */
  keyUrl?: string;
  placeholder: string;
  keyRule: SecretRule;
  /** Step 3 key this preset can reuse, when the server has it. */
  reuseKey?: ReuseKey;
  /** Label of the model field. Default: "Model". */
  modelLabel?: string;
  /** The URL field takes something else than the base URL itself. */
  url?: {
    label: string;
    placeholder: string;
    /** The base URL the probe calls, from what the operator typed. */
    resolve: (input: string) => string;
  };
}

// R6: no Ollama preset. The stored vector size is fixed (EMBEDDING_DIMENSIONS).
const PRESETS: Preset[] = [
  {
    id: "openai",
    label: "OpenAI",
    logo: "/provider-logos/openai.svg",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "text-embedding-3-small", tradeoff: SMALL_TRADEOFF },
      { id: "text-embedding-3-large", tradeoff: LARGE_TRADEOFF },
    ],
    keyLabel: "OpenAI API key",
    keyUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-proj-...",
    keyRule: KEY_RULES.openAi,
    reuseKey: "OPENAI_API_KEY",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    logo: "/provider-logos/openrouter.svg",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { id: "openai/text-embedding-3-small", tradeoff: SMALL_TRADEOFF },
      { id: "openai/text-embedding-3-large", tradeoff: LARGE_TRADEOFF },
      {
        id: "google/gemini-embedding-2",
        tradeoff: "Google's multimodal model, 10x the price of the recommended model.",
      },
    ],
    keyLabel: "OpenRouter API key",
    keyUrl: "https://openrouter.ai/settings/keys",
    placeholder: "sk-or-v1-...",
    keyRule: KEY_RULES.openRouter,
    reuseKey: "OPENROUTER_API_KEY",
  },
  {
    id: "vercel",
    label: "Vercel AI Gateway",
    logo: "/integration-logos/vercel.svg",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    models: [
      { id: "openai/text-embedding-3-small", tradeoff: SMALL_TRADEOFF },
      { id: "openai/text-embedding-3-large", tradeoff: LARGE_TRADEOFF },
      {
        id: "google/gemini-embedding-001",
        tradeoff: "Strong on multilingual and code text, 7.5x the price of the recommended model.",
      },
    ],
    keyLabel: "AI Gateway API key",
    keyUrl:
      "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys",
    placeholder: "vck_...",
    keyRule: KEY_RULES.vercel,
  },
  {
    id: "azure",
    label: "Azure / Microsoft Foundry",
    logo: "/integration-logos/microsoft.svg",
    baseUrl: "",
    // Deployment names are chosen per resource: no chips.
    models: [],
    modelLabel: "Deployment name",
    url: {
      label: "Resource",
      placeholder: "my-resource or https://my-resource.services.ai.azure.com",
      resolve: azureBaseUrl,
    },
    keyLabel: "Resource API key",
    placeholder: "••••",
    keyRule: {},
  },
  {
    id: "custom",
    label: "Custom",
    baseUrl: "",
    models: [],
    keyLabel: "API key",
    placeholder: "••••",
    // Unknown format: 16+ characters.
    keyRule: {},
  },
];

/** The amber state of a selected outline button (preset, model, reuse). */
const SELECTED =
  "border-primary/60 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary";

function errorHint(errorClass: OnboardingErrorClass | undefined, dims: number): string {
  switch (errorClass) {
    case "auth":
      return "The key was rejected.";
    case "model":
      return "The model or deployment was not found at this endpoint.";
    case "endpoint":
      return "The endpoint path was not found. Check the base URL.";
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

/** A preset, or no key at all (keyword search only). */
type MemoryChoice = Preset["id"] | "keyword";

/**
 * The choice `/setup` opens with: the first preset whose step 3 key the
 * server has. Without one, keyword search only, unless the server already
 * has an embeddings key.
 */
function defaultMemoryChoice(
  presence: EnvPresenceMap | undefined,
  configured: boolean,
): MemoryChoice {
  const reusable = PRESETS.find((p) => p.reuseKey && presence?.[p.reuseKey]);
  if (reusable) return reusable.id;
  return configured ? PRESETS[0].id : "keyword";
}

/** Step 5: memory. */
export function StepMemory({ onboarding, act, setContinueBlocker, setContinueAction }: StepProps) {
  const { configured, dimensions } = onboarding.signals.embeddings;
  const status = onboarding.state.steps.memory.status;
  const presenceQ = useEnvPresence(REUSE_KEYS);
  // The default choice reads the step 3 keys once. Wait for a fresh read (a
  // persisted cache can predate step 3), then keep the form mounted.
  const [loaded, setLoaded] = useState(false);
  if (!loaded && !presenceQ.isPending && !presenceQ.isFetching) setLoaded(true);
  if (!loaded) return <Skeleton className="h-72 w-full rounded-xl" />;
  return (
    <EmbeddingsSetup
      configured={configured}
      dimensions={dimensions}
      done={status === "done"}
      keySource="step 3"
      setContinueBlocker={setContinueBlocker}
      setup={{
        initial: defaultMemoryChoice(presenceQ.data, configured),
        skipped: status === "skipped",
        skip: async () => {
          await act({ action: "skip", step: "memory" });
        },
        setContinueAction: (action) => setContinueAction(action, { unlocks: true }),
      }}
    />
  );
}

/** What only `/setup` adds to the form. */
interface SetupOptions {
  /** The choice selected at mount. */
  initial: MemoryChoice;
  /** The step is skipped already: Continue just moves on. */
  skipped: boolean;
  /** Skip the step: what Continue does for keyword search only. */
  skip: () => Promise<void>;
  setContinueAction: ContinueActionSetter;
}

/**
 * The embeddings form of `/setup` step 5 and the Memory integration. No Save
 * button: once the fields are valid, it runs the test-and-save probe by itself
 * (one embedding call; the API stores the config only when it works). A typed
 * key tests on paste or blur only, never half-typed. A result shows only while
 * the fields still match it.
 *
 * With `setup` (`/setup` step 5): a "Keyword search only" choice, reuse of a
 * step 3 key on by default, and Continue tests the untouched default (never
 * on view). The settings page leaves `setup` out.
 */
export function EmbeddingsSetup({
  configured,
  dimensions,
  done = false,
  keySource,
  setContinueBlocker,
  setup,
}: {
  /** The server already has an embeddings key. */
  configured: boolean;
  dimensions: number;
  /** A probe already passed (the setup step is done). */
  done?: boolean;
  /** Where a reusable key comes from, as in "Reuse key from step 3". Default: saved. */
  keySource?: string;
  /** Holds the caller's Continue while a probe runs. */
  setContinueBlocker: ContinueBlockerSetter;
  setup?: SetupOptions;
}) {
  const scope = useAutosaveScope(setContinueBlocker);
  const [preset, setPreset] = useState<Preset>(
    () => PRESETS.find((p) => p.id === setup?.initial) ?? PRESETS[0],
  );
  const [keyword, setKeyword] = useState(setup?.initial === "keyword");
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [model, setModel] = useState(preset.models[0]?.id ?? "");
  // "Other": a model id outside the preset's chips, typed by hand.
  const [other, setOther] = useState(false);
  const [apiKey, setApiKey] = useState("");
  // `/setup` reuses the step 3 key by default.
  const [reuse, setReuse] = useState(setup !== undefined);
  const [keyBlurred, setKeyBlurred] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const test = useTestOnboardingMemory();
  const presenceQ = useEnvPresence(REUSE_KEYS);

  // No key to fall back to: keyword search is what memory does without one.
  const offerKeyword = setup !== undefined && !configured;
  const keywordOnly = keyword && offerKeyword;
  const reuseKey =
    preset.reuseKey && presenceQ.data?.[preset.reuseKey] ? preset.reuseKey : undefined;
  const usingReuse = reuse && reuseKey !== undefined;
  const freeText = other || preset.models.length === 0;
  // Azure and Custom need their URL. In `/setup` a fixed preset URL waits
  // under Advanced (the settings page has its own Advanced fields).
  const urlInline = !setup || Boolean(preset.url) || preset.baseUrl === "";

  const url = preset.url ? preset.url.resolve(baseUrl) : baseUrl.trim();
  const modelId = model.trim();
  const key = apiKey.trim();
  const urlError = url ? baseUrlError(url) : null;
  const urlHint = preset.url || urlError ? null : azurePathHint(url);
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
  // The setup the form opened with. A `/setup` default (a reused key) is
  // never tested on view: Continue tests it.
  const [initialCandidate] = useState(candidate);
  const untouched = candidate === initialCandidate;

  /**
   * Test one request and keep its outcome. Throws when the same setup can
   * work on a retry (the request failed, or the endpoint was unreachable),
   * so the autosave keeps it retryable.
   */
  async function run(request: OnboardingMemoryTestRequest): Promise<Outcome> {
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
    return next;
  }

  const probe = useAutosave({
    value: candidate,
    dirty: !untouched && !keywordOnly && fieldsOk && (usingReuse || key.length > 0),
    // Without a typed key nothing is half-typed: test after the debounce.
    ready: fieldsOk && usingReuse,
    readyOnCommit: fieldsOk && (usingReuse || keyCheck.valid),
    save: async (value) => {
      await run(JSON.parse(value) as OnboardingMemoryTestRequest);
    },
  });

  const paste = usePasteCommit(probe.commit);

  // `/setup` Continue: keyword search only skips the step. An untouched
  // default tests first (the reused key, or the setup the server has).
  const continueRequest: OnboardingMemoryTestRequest | null = !untouched
    ? null
    : usingReuse && fieldsOk
      ? body
      : configured
        ? { preset: "existing" }
        : null;
  useContinueAction(
    setup?.setContinueAction ?? noContinueAction,
    // A settled step needs no action: Continue moves on, as before.
    !setup || done || setup.skipped
      ? null
      : keywordOnly
        ? setup.skip
        : continueRequest
          ? async () => {
              const next = await run(continueRequest);
              if (next.kind === "result" && !next.result.ok) {
                throw new Error(errorHint(next.result.errorClass, dimensions));
              }
            }
          : null,
  );

  function selectPreset(next: Preset) {
    setPreset(next);
    setKeyword(false);
    setBaseUrl(next.baseUrl);
    setModel(next.models[0]?.id ?? "");
    setOther(false);
    setApiKey("");
    setReuse(setup !== undefined);
    setKeyBlurred(false);
    setOutcome(null);
  }

  /** A chip pick commits like leaving a field: it tests at once when the key is ready. */
  function pickModel(id: string) {
    setModel(id);
    setOther(false);
    probe.commit();
  }

  function pickOther() {
    if (other) return;
    setOther(true);
    setModel("");
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

  const header: { tone: StatusTone; label: string } = keywordOnly
    ? { tone: "none", label: "" }
    : probing
      ? { tone: "busy", label: "Testing the endpoint…" }
      : probe.phase === "pending"
        ? { tone: "dirty", label: "Tests when you stop typing" }
        : result && !result.ok
          ? { tone: "error", label: errorHint(result.errorClass, dimensions) }
          : shown?.kind === "request-error"
            ? { tone: "error", label: "Could not run the test." }
            : done || result?.ok
              ? { tone: "done", label: "Memory works" }
              : { tone: "none", label: "" };

  const urlRow = (
    <SettingsRow
      label={preset.url?.label ?? "Base URL"}
      htmlFor="memory-base-url"
      helper={
        urlError ? (
          <span className="text-status-error-strong">{urlError}</span>
        ) : urlHint ? (
          <span className="text-status-warning-strong">{urlHint}</span>
        ) : preset.url && url ? (
          <span>
            Calls <span className="break-all font-mono">{url}</span>
          </span>
        ) : undefined
      }
    >
      <Input
        id="memory-base-url"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        onBlur={probe.commit}
        placeholder={preset.url?.placeholder ?? "https://embeddings.example.com/v1"}
        spellCheck={false}
        aria-invalid={urlError ? true : undefined}
        className="font-mono"
      />
    </SettingsRow>
  );

  return (
    <AutosaveScopeContext.Provider value={scope}>
      <SetupCard
        title={
          <span className="flex items-center gap-1.5">
            Memory search
            <InfoTip content="With a key, agents find past work by meaning, not only by exact words. The test sends one sample text, then discards it." />
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
              {testingExisting ? <Spinner className="size-3.5" /> : null}
              Test current setup
            </Button>
          </div>
        ) : null}

        <div role="radiogroup" aria-label="Provider" className="flex flex-wrap gap-2">
          {PRESETS.map((p) => {
            const active = !keywordOnly && p.id === preset.id;
            return (
              <Button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                variant="outline"
                size="sm"
                onClick={() => selectPreset(p)}
                className={cn(active && SELECTED)}
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
          {offerKeyword ? (
            <Button
              type="button"
              role="radio"
              aria-checked={keywordOnly}
              variant="outline"
              size="sm"
              onClick={() => {
                setKeyword(true);
                setOutcome(null);
              }}
              className={cn(keywordOnly && SELECTED)}
            >
              <TextSearch className="size-4" />
              Keyword search only
            </Button>
          ) : null}
        </div>

        {keywordOnly ? (
          <FadeIn key="keyword" className="space-y-1 text-sm">
            <p>No key needed. Agents save memories and find them by keyword.</p>
            <p className="text-muted-foreground">
              Search by meaning stays off. Add a key later in{" "}
              {/* A new tab keeps setup open in this one. */}
              <Link
                to={setupExitHref("/settings/integrations/memory")}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                Settings, Integrations, Memory
              </Link>
              . Earlier memories are indexed then.
            </p>
          </FadeIn>
        ) : (
          <>
            <SettingsRow
              label={preset.modelLabel ?? "Model"}
              htmlFor={freeText ? "memory-model" : undefined}
            >
              {preset.models.length > 0 ? (
                <div role="radiogroup" aria-label="Model" className="flex flex-wrap gap-2">
                  {preset.models.map((m, i) => (
                    <ChoiceChip
                      key={m.id}
                      selected={!other && m.id === model}
                      onClick={() => pickModel(m.id)}
                      tip={
                        <span className="flex flex-col gap-0.5">
                          <span className="font-mono">{m.id}</span>
                          <span>{m.tradeoff}</span>
                        </span>
                      }
                    >
                      <ModelLogo model={m.id} className="size-4" />
                      {modelDisplayName(m.id)}
                      {i === 0 ? <SetupChip tone="info">Recommended</SetupChip> : null}
                    </ChoiceChip>
                  ))}
                  <ChoiceChip
                    selected={other}
                    onClick={pickOther}
                    tip={`Type any model id. It must support ${dimensions} dimensions.`}
                  >
                    <TextCursorInput className="size-4" />
                    Other
                  </ChoiceChip>
                </div>
              ) : null}
              {/* The padding keeps the focus ring inside the reveal's clip. */}
              <AnimatedReveal open={freeText} className="-m-1 p-1">
                <Input
                  id="memory-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={probe.commit}
                  placeholder={preset.models[0]?.id ?? "text-embedding-3-small"}
                  spellCheck={false}
                  autoFocus={other}
                  className="font-mono"
                />
              </AnimatedReveal>
            </SettingsRow>

            {urlInline ? urlRow : null}

            <SettingsRow
              label={preset.keyLabel}
              htmlFor="memory-api-key"
              helper={
                keyProblem ? (
                  <span className="text-status-error-strong">{keyProblem}</span>
                ) : shown || probing ? undefined : setup && usingReuse ? (
                  untouched ? (
                    "Continue tests this key, then saves it."
                  ) : undefined
                ) : (
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
                    autoComplete="new-password"
                    placeholder={
                      usingReuse
                        ? keySource
                          ? `Using the key from ${keySource}`
                          : "Using the saved key"
                        : preset.placeholder
                    }
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
                    className={cn(usingReuse && SELECTED)}
                  >
                    {usingReuse ? <Check /> : null}
                    {keySource ? `Reuse key from ${keySource}` : "Reuse saved key"}
                  </Button>
                ) : null}
                {preset.keyUrl && !usingReuse ? (
                  <span className="text-sm">
                    <ExternalTextLink href={preset.keyUrl}>Get a key</ExternalTextLink>
                  </span>
                ) : null}
              </div>
            </SettingsRow>

            {urlInline ? null : (
              <CollapsibleSection key={preset.id} title="Advanced">
                <div className="pt-2">{urlRow}</div>
              </CollapsibleSection>
            )}

            <ProbeResult
              probing={probing}
              outcome={shown}
              dimensions={dimensions}
              onRetry={shown && isRetryable(shown) && !test.isPending ? retry : undefined}
            />
          </>
        )}
      </SetupCard>
    </AutosaveScopeContext.Provider>
  );
}

/** The settings page has no Continue to act on. */
function noContinueAction() {}

/** One option of a radiogroup, styled like the preset buttons, with a tooltip. */
function ChoiceChip({
  selected,
  onClick,
  tip,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  tip: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          role="radio"
          aria-checked={selected}
          variant="outline"
          size="sm"
          onClick={onClick}
          className={cn(selected && SELECTED)}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{tip}</TooltipContent>
    </Tooltip>
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
