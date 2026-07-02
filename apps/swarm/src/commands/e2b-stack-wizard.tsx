import { Select, TextInput } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useState } from "react";

/**
 * Interactive wizard for `e2b start-stack`. Collects the handful of decisions an
 * operator makes when launching a swarm (name → slug, worker count, provider,
 * TTL, env files, integrations), skipping any step whose flag was already
 * provided on the command line. On finish it resolves a {@link StackWizardResult}
 * back to the caller, which translates it into flags and (optionally) echoes the
 * equivalent headless `--yes` command.
 *
 * Consistency with `onboard*.tsx`: Ink + `@inkjs/ui` `Select`/`TextInput`,
 * one logical question per render, `useApp().exit()` to tear down on completion.
 *
 * Headless detection lives in the caller (`e2b.ts`) — this component is only
 * ever rendered when interactive, so it always reads from stdin.
 */

/** Integrations the wizard can toggle. Each maps to an API-side `*_DISABLE` env. */
export const STACK_INTEGRATIONS = ["slack", "github", "jira", "linear"] as const;
export type StackIntegration = (typeof STACK_INTEGRATIONS)[number];

/** Provider choices surfaced in the wizard picker (mirrors HARNESS_PROVIDER). */
export const STACK_PROVIDERS = ["claude", "codex", "pi", "devin"] as const;

export const DEFAULT_STACK_WORKERS = 1;
export const DEFAULT_STACK_TIMEOUT_SEC = 3600;

/**
 * The shape the wizard resolves. `undefined` fields mean "the operator did not
 * change the prebaked flag/default" — the caller already has the flag value, so
 * it only overrides with wizard answers that were actually collected.
 */
export type StackWizardResult = {
  swarmSlug: string;
  workers: number;
  provider: string;
  timeoutSec: number;
  /** Shared --env-file paths the operator typed (comma/space separated → array). */
  envFiles: string[];
  /** Map of integration → enabled. A disabled integration becomes `*_DISABLE=true`. */
  integrations: Record<StackIntegration, boolean>;
  noLead: boolean;
};

/** Which wizard steps to skip because their value already came from a flag. */
export type StackWizardSkips = {
  swarm?: boolean;
  workers?: boolean;
  provider?: boolean;
  timeout?: boolean;
  envFiles?: boolean;
  integrations?: boolean;
};

export type StackWizardDefaults = {
  swarmSlug?: string;
  workers: number;
  provider: string;
  timeoutSec: number;
  envFiles: string[];
  integrations: Record<StackIntegration, boolean>;
  noLead: boolean;
};

export type StackWizardProps = {
  defaults: StackWizardDefaults;
  skips: StackWizardSkips;
  onComplete: (result: StackWizardResult) => void;
};

/** Lowercase, dash-separated slug suitable for a swarm name / metadata value. */
export function slugify(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "swarm"
  );
}

/** Human preview of when a TTL of `seconds` from now would expire. */
function expiryPreview(seconds: number): string {
  const expires = new Date(Date.now() + seconds * 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes}m`);
  return `${parts.join(" ")} from now (~${expires.toLocaleTimeString()})`;
}

type WizardStep =
  | "mode"
  | "swarm"
  | "workers"
  | "provider"
  | "timeout"
  | "env_files"
  | "integrations"
  | "done";

export function StackWizard({ defaults, skips, onComplete }: StackWizardProps) {
  const { exit } = useApp();

  // Accumulated answers, seeded from the flag-provided defaults.
  const [result, setResult] = useState<StackWizardResult>({
    swarmSlug: defaults.swarmSlug ?? "",
    workers: defaults.workers,
    provider: defaults.provider,
    timeoutSec: defaults.timeoutSec,
    envFiles: defaults.envFiles,
    integrations: { ...defaults.integrations },
    noLead: defaults.noLead,
  });

  // Determine the ordered list of steps, skipping any that are flag-satisfied.
  const steps: WizardStep[] = ["mode"];
  if (!skips.swarm) steps.push("swarm");
  if (!skips.workers) steps.push("workers");
  if (!skips.provider) steps.push("provider");
  if (!skips.timeout) steps.push("timeout");
  if (!skips.envFiles) steps.push("env_files");
  if (!skips.integrations) steps.push("integrations");
  steps.push("done");

  const [stepIdx, setStepIdx] = useState(0);
  const step = steps[stepIdx] ?? "done";
  const [error, setError] = useState("");
  // Toggle scratch state for the integrations multi-step.
  const [integrationToggles, setIntegrationToggles] = useState<Record<StackIntegration, boolean>>({
    ...defaults.integrations,
  });

  const advance = (partial?: Partial<StackWizardResult>) => {
    setError("");
    if (partial) setResult((r) => ({ ...r, ...partial }));
    const nextIdx = stepIdx + 1;
    setStepIdx(nextIdx);
    if ((steps[nextIdx] ?? "done") === "done") {
      // Resolve on the freshest result; merge any pending partial.
      setResult((r) => {
        const finalResult = { ...r, ...partial };
        // Defer the callback so React finishes its commit before we exit.
        queueMicrotask(() => {
          onComplete(finalResult);
          exit();
        });
        return finalResult;
      });
    }
  };

  if (step === "done") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">Configuration captured — launching…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        Agent Swarm — E2B stack launcher
      </Text>
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {step === "mode" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Create a new swarm or add to an existing one?</Text>
          <Box marginTop={1}>
            <Select
              options={[
                { label: "Create a new swarm", value: "create" },
                // Phase 4: the add-to-existing flow lives in the standalone
                // `e2b swarms add` command, which has its own TTY swarm picker,
                // `--workers`/`--add-lead` flags, and TTL re-sync to the group's
                // end. Rather than fork that whole flow into this wizard (which
                // is scoped to *creating* a stack), we point the operator at it.
                // This keeps a single, fully-working add path instead of a
                // half-duplicated one.
                { label: "Add to an existing swarm (run: e2b swarms add <slug>)", value: "add" },
              ]}
              onChange={(value) => {
                if (value === "add") {
                  setError(
                    "To add to an existing swarm, exit and run: e2b swarms add <slug> " +
                      "(no slug → it lists your swarms to pick from). Choose 'Create a new swarm' to continue here.",
                  );
                  return;
                }
                advance();
              }}
            />
          </Box>
        </Box>
      )}

      {step === "swarm" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Swarm name:</Text>
          <Text dimColor>Used as the group slug and dashboard name.</Text>
          <Box marginTop={1}>
            <TextInput
              key="swarm-name"
              placeholder="my-swarm"
              defaultValue={result.swarmSlug}
              onSubmit={(raw) => {
                const slug = slugify(raw || "swarm");
                advance({ swarmSlug: slug });
              }}
            />
          </Box>
        </Box>
      )}

      {step === "workers" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>How many workers?</Text>
          <Box marginTop={1}>
            <TextInput
              key="workers"
              placeholder={String(result.workers)}
              defaultValue={String(result.workers)}
              onSubmit={(raw) => {
                const trimmed = raw.trim();
                const parsed = trimmed ? Number.parseInt(trimmed, 10) : result.workers;
                // Keep this in lock-step with the headless `integerFlag("workers")`
                // contract, which requires a positive integer.
                if (!Number.isFinite(parsed) || parsed < 1) {
                  setError("Enter a positive integer (at least 1 worker).");
                  return;
                }
                advance({ workers: parsed });
              }}
            />
          </Box>
        </Box>
      )}

      {step === "provider" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Harness provider:</Text>
          <Box marginTop={1}>
            <Select
              options={STACK_PROVIDERS.map((p) => ({ label: p, value: p }))}
              onChange={(value) => advance({ provider: value })}
            />
          </Box>
        </Box>
      )}

      {step === "timeout" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Sandbox TTL (seconds):</Text>
          <Text dimColor>
            Default {result.timeoutSec}s — {expiryPreview(result.timeoutSec)}.
          </Text>
          <Box marginTop={1}>
            <TextInput
              key="timeout"
              placeholder={String(result.timeoutSec)}
              defaultValue={String(result.timeoutSec)}
              onSubmit={(raw) => {
                const trimmed = raw.trim();
                const parsed = trimmed ? Number.parseInt(trimmed, 10) : result.timeoutSec;
                if (!Number.isFinite(parsed) || parsed <= 0) {
                  setError("Enter a positive integer (seconds).");
                  return;
                }
                advance({ timeoutSec: parsed });
              }}
            />
          </Box>
        </Box>
      )}

      {step === "env_files" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Shared env file(s):</Text>
          <Text dimColor>Comma-separated paths applied to all roles, or leave blank.</Text>
          <Box marginTop={1}>
            <TextInput
              key="env-files"
              placeholder=".env"
              defaultValue={result.envFiles.join(",")}
              onSubmit={(raw) => {
                const files = raw
                  .split(",")
                  .map((p) => p.trim())
                  .filter(Boolean);
                advance({ envFiles: files });
              }}
            />
          </Box>
        </Box>
      )}

      {step === "integrations" && (
        <IntegrationToggleStep
          toggles={integrationToggles}
          setToggles={setIntegrationToggles}
          onContinue={() => advance({ integrations: { ...integrationToggles } })}
        />
      )}
    </Box>
  );
}

/**
 * One-shot picker over existing swarm slugs, used by `e2b swarms add` when no
 * slug was passed on an interactive TTY. Resolves the chosen slug back to the
 * caller via `onSelect`, then exits. Consistent with the wizard's Ink + Select.
 */
export type SwarmPickerOption = { slug: string; label: string };

export function SwarmPicker({
  slugs,
  onSelect,
}: {
  slugs: SwarmPickerOption[];
  onSelect: (slug: string) => void;
}) {
  const { exit } = useApp();
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        Add to which swarm?
      </Text>
      <Box marginTop={1}>
        <Select
          options={slugs.map((s) => ({ label: s.label, value: s.slug }))}
          onChange={(value) => {
            // Defer so React commits before we tear down the Ink instance.
            queueMicrotask(() => {
              onSelect(value);
              exit();
            });
          }}
        />
      </Box>
    </Box>
  );
}

const CONTINUE_VALUE = "__continue__";

function IntegrationToggleStep({
  toggles,
  setToggles,
  onContinue,
}: {
  toggles: Record<StackIntegration, boolean>;
  setToggles: (
    update: (prev: Record<StackIntegration, boolean>) => Record<StackIntegration, boolean>,
  ) => void;
  onContinue: () => void;
}) {
  const options = [
    ...STACK_INTEGRATIONS.map((key) => ({
      label: `${toggles[key] ? "[x]" : "[ ]"} ${key}`,
      value: key as string,
    })),
    { label: "Continue →", value: CONTINUE_VALUE },
  ];

  return (
    <Box marginTop={1} flexDirection="column">
      <Text bold>Integrations (enabled = on):</Text>
      <Text dimColor>Disabled integrations set the matching *_DISABLE env on the API.</Text>
      <Box marginTop={1}>
        <Select
          options={options}
          onChange={(value) => {
            if (value === CONTINUE_VALUE) {
              onContinue();
              return;
            }
            const key = value as StackIntegration;
            setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
          }}
        />
      </Box>
    </Box>
  );
}
