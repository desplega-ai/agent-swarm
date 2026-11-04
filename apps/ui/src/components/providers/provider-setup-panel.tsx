import { AlertCircle, ExternalLink, LogIn } from "lucide-react";
import { Fragment, type ReactNode, useId, useState } from "react";
import { Link } from "react-router-dom";
import { useConfigs, useUpsertConfigsBatch } from "@/api/hooks/use-config-api";
import { Spinner } from "@/components/kibo-ui/spinner";
import { KEY_RULES, type SecretRule } from "@/components/onboarding/autosave-secret-field";
import { CodexAccountsList } from "@/components/onboarding/codex-accounts-list";
import { PoolKeysList } from "@/components/onboarding/pool-keys-list";
import { CopyIconButton } from "@/components/shared/copy-icon-button";
import { SecretInput } from "@/components/shared/secret-input";
import { StatusLine } from "@/components/shared/status-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCodexDeviceFlow } from "@/hooks/use-codex-device-flow";
import { useConfig } from "@/hooks/use-config";
import type { AiProvider, AiProviderField } from "@/lib/ai-providers";
import { DeviceCodePanel } from "./codex-device-code";
import { ProviderLogo } from "./provider-logo";

/** Format rules checked before the add request. Other pools take any value of 16+ characters. */
const POOL_RULES: Record<string, SecretRule> = {
  CLAUDE_CODE_OAUTH_TOKEN: KEY_RULES.claudeToken,
  ANTHROPIC_API_KEY: KEY_RULES.anthropicKey,
};

/** `code` in backticks and `[label](https://...)` links, as step text writes them. */
function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
              {part.slice(1, -1)}
            </code>
          );
        }
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) {
          return (
            <a
              key={i}
              href={link[2]}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {link[1]}
            </a>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-b border-border-subtle px-5 py-4 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A field label, with the config key name small on the right. */
function FieldLabel({
  htmlFor,
  field,
}: {
  htmlFor: string;
  field: Pick<AiProviderField, "label" | "key" | "optional">;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {field.label}
        {field.optional ? (
          <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span>
        ) : null}
      </label>
      <code className="truncate font-mono text-[11px] text-muted-foreground">{field.key}</code>
    </div>
  );
}

function PoolField({ provider, field }: { provider: AiProvider; field: AiProviderField }) {
  const id = useId();
  const helpId = useId();
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor={id} field={field} />
      <PoolKeysList
        envVar={field.key}
        inputId={id}
        label={`${provider.name} ${field.label}`}
        rule={POOL_RULES[field.key]}
        placeholder={field.placeholder}
        describedBy={field.help ? helpId : undefined}
      />
      {field.help ? (
        <p id={helpId} className="text-xs text-muted-foreground">
          {field.help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Plain global config values (a region, an ID, a base URL, a static secret),
 * saved together with one Save. A stored secret never comes back: its input
 * stays empty and says it is saved, and an empty input keeps it.
 */
function ConfigFields({ fields }: { fields: AiProviderField[] }) {
  const baseId = useId();
  const { data: configs } = useConfigs({ scope: "global" });
  const upsert = useUpsertConfigsBatch();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const stored = (key: string) => configs?.find((c) => c.key === key && c.scope === "global");

  const changes = fields.flatMap((field) => {
    const draft = drafts[field.key];
    if (draft === undefined) return [];
    const value = draft.trim();
    const current = stored(field.key);
    if (!value) return [];
    if (field.kind === "text" && current?.value === value) return [];
    return [{ key: field.key, value, isSecret: field.kind === "secret" }];
  });

  function save() {
    if (changes.length === 0 || upsert.isPending) return;
    setResult(null);
    upsert.mutate(changes, {
      onSuccess: (res) => {
        if (res.failureCount === 0) {
          setDrafts({});
          setResult({ ok: true, text: "Saved. Workers use it on their next task." });
        } else {
          setResult({ ok: false, text: res.errors[0]?.message ?? "Could not save." });
        }
      },
      onError: (err) => setResult({ ok: false, text: err.message }),
    });
  }

  return (
    <div className="space-y-3">
      {fields.map((field) => {
        const id = `${baseId}-${field.key}`;
        const current = stored(field.key);
        const draft = drafts[field.key];
        const setDraft = (value: string) => {
          setResult(null);
          setDrafts((d) => ({ ...d, [field.key]: value }));
        };
        return (
          <div key={field.key} className="space-y-1.5">
            <FieldLabel htmlFor={id} field={field} />
            {field.kind === "secret" ? (
              <SecretInput
                id={id}
                value={draft ?? ""}
                onChange={setDraft}
                placeholder={
                  current ? "Saved. Paste a new value to replace it." : field.placeholder
                }
                autoComplete="new-password"
              />
            ) : (
              <Input
                id={id}
                value={draft ?? current?.value ?? ""}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={field.placeholder}
                className="font-mono"
                spellCheck={false}
              />
            )}
            {field.help ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={changes.length === 0 || upsert.isPending}>
          {upsert.isPending ? (
            <>
              <Spinner className="size-4" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
        <output className="text-xs">
          {result ? (
            <StatusLine tone={result.ok ? "success" : "error"}>{result.text}</StatusLine>
          ) : null}
        </output>
      </div>
    </div>
  );
}

/** The ChatGPT device sign-in, the stored accounts, and the CLI fallback. */
function CodexSignIn() {
  const { config } = useConfig();
  const { flow, start } = useCodexDeviceFlow();
  const apiUrl = config.apiUrl || window.location.origin;
  const cli = `npx @desplega.ai/agent-swarm codex-login --api-url ${apiUrl}`;
  const signInButton = (label: string) => (
    <Button type="button" onClick={() => void start()}>
      <LogIn />
      {label}
    </Button>
  );

  return (
    <>
      <Section title="Accounts">
        <CodexAccountsList />
        {flow.phase === "idle" ? signInButton("Sign in with ChatGPT") : null}
        {flow.phase === "starting" ? (
          <Button type="button" disabled>
            <Spinner className="size-4" />
            Requesting a code
          </Button>
        ) : null}
        {flow.phase === "polling" ? <DeviceCodePanel flow={flow.flow} /> : null}
        {flow.phase === "complete" ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <StatusLine tone="success">
              {flow.slot === undefined
                ? "Signed in. The account joined the pool."
                : `Signed in. The account joined the pool as slot ${flow.slot}.`}
            </StatusLine>
            {signInButton("Sign in another account")}
          </div>
        ) : null}
        {flow.phase === "start_error" || flow.phase === "failed" ? (
          <>
            <AlertCallout tone="error" icon={AlertCircle}>
              {flow.error}
            </AlertCallout>
            {signInButton("Try again")}
          </>
        ) : null}
      </Section>
      <Section title="Other ways to sign in">
        <p className="text-sm text-muted-foreground">
          Device login failed, or no browser here? Run this on a machine with a browser.
        </p>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all">
            {cli}
          </code>
          <CopyIconButton value={cli} label="Copy command" />
        </div>
      </Section>
    </>
  );
}

function stepsTitle(provider: AiProvider): string {
  if (provider.id === "codex") return "How to sign in";
  if (provider.type === "System One") return `Get a ${provider.noun}`;
  if (!provider.poolVar) return "Before you start";
  return `Get a ${provider.noun}`;
}

function liveCheckLine(provider: AiProvider): string {
  if (provider.footer) return provider.footer;
  if (provider.id === "codex") return "Each sign-in adds one account to the pool.";
  if (!provider.fields.some((f) => f.kind === "pool")) {
    return "No live check here: the provider checks it when a task runs.";
  }
  if (provider.liveCheck) {
    return `${provider.vendor} checks each new ${provider.noun} first. A rejected ${provider.noun} is not saved.`;
  }
  return `No live check for ${provider.name}. A worker checks the ${provider.noun} on its next task.`;
}

/**
 * The right side panel of one provider: the real setup steps (with a copy
 * button on commands), then the fields. Pool fields add one key at a time
 * through `/api/config/pool-keys`: the API checks the key first and a
 * rejected key saves nothing (the reason shows under the field). Other
 * fields save with Save. Codex signs in through the device flow.
 */
export function ProviderSetupPanel({
  provider,
  onOpenChange,
}: {
  /** The open provider, or null when the panel is closed. */
  provider: AiProvider | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={provider !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        {provider ? <PanelBody key={provider.id} provider={provider} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({ provider }: { provider: AiProvider }) {
  const configFields = provider.fields.filter((f) => f.kind !== "pool");
  let configRendered = false;

  return (
    <>
      <SheetHeader className="flex-row items-start gap-3 border-b border-border-subtle px-5 py-4 pr-12">
        <ProviderLogo provider={provider} className="size-10" />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>{provider.name}</SheetTitle>
            <Badge variant="outline" size="tag">
              {provider.type}
            </Badge>
          </div>
          <SheetDescription>{provider.summary}</SheetDescription>
          <p className="text-xs text-muted-foreground">Used by {provider.harnesses.join(", ")}.</p>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <Section
          title={stepsTitle(provider)}
          aside={
            <a
              href={provider.docs.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
            >
              {provider.docs.label}
              <ExternalLink aria-hidden className="size-3" />
            </a>
          }
        >
          <ol className="space-y-2.5">
            {provider.steps.map((step, i) => (
              <li key={step.text} className="flex gap-3 text-sm">
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[11px] text-muted-foreground"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                  <p>
                    <InlineText text={step.text} />
                  </p>
                  {step.command ? (
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all">
                        <span aria-hidden className="mr-2 text-muted-foreground">
                          $
                        </span>
                        {step.command}
                      </code>
                      <CopyIconButton value={step.command} label="Copy command" />
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {provider.note ? (
            <p className="text-xs text-muted-foreground">
              <InlineText text={provider.note} />
            </p>
          ) : null}
        </Section>

        {provider.id === "codex" ? (
          <CodexSignIn />
        ) : (
          <Section
            title={
              provider.poolVar
                ? `Add the ${provider.noun}`
                : provider.type === "System One"
                  ? "Credentials"
                  : "Settings"
            }
          >
            {provider.fields.map((field) => {
              if (field.kind === "pool") {
                return <PoolField key={field.key} provider={provider} field={field} />;
              }
              // Config fields save together, in the place of the first one.
              if (configRendered) return null;
              configRendered = true;
              return <ConfigFields key="config" fields={configFields} />;
            })}
          </Section>
        )}
      </div>

      <SheetFooter className="flex-row flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-5 py-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{liveCheckLine(provider)}</p>
        {provider.settingsPath ? (
          <Button asChild variant="outline" size="sm">
            <Link to={provider.settingsPath}>All settings</Link>
          </Button>
        ) : null}
      </SheetFooter>
    </>
  );
}
