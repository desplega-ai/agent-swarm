import {
  Activity,
  Bot,
  Brain,
  Bug,
  ChartLine,
  ExternalLink,
  GitBranch,
  Github,
  GitMerge,
  Info,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Mail,
  MessageSquare,
  Plug,
  Route,
  Sparkles,
  SquareCheckBig,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  type UpsertConfigEntry,
  useConfigs,
  useDeleteConfigsBatch,
  useUpsertConfigsBatch,
} from "@/api/hooks/use-config-api";
import {
  type EnvPresenceMap,
  useEnvPresence,
  useReloadConfig,
} from "@/api/hooks/use-integrations-meta";
import type { SwarmConfig } from "@/api/types";
import { CodexOAuthSection } from "@/components/integrations/codex-oauth-section";
import { FieldRenderer } from "@/components/integrations/field-renderer";
import { IntegrationStatusBadge } from "@/components/integrations/integration-status-badge";
import { LinearOAuthSection } from "@/components/integrations/linear-oauth-section";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  INTEGRATIONS,
  type IntegrationDef,
  type IntegrationField,
} from "@/lib/integrations-catalog";
import { deriveIntegrationStatus, findConfigForKey } from "@/lib/integrations-status";

// Mirror of the ICON_MAP in integration-card — keeps the detail page rendering
// the same icon as the card without a round-trip import.
const ICON_MAP: Record<string, LucideIcon> = {
  "message-square": MessageSquare,
  github: Github,
  "git-merge": GitMerge,
  "git-branch": GitBranch,
  "square-check-big": SquareCheckBig,
  "list-checks": ListChecks,
  activity: Activity,
  bug: Bug,
  mail: Mail,
  brain: Brain,
  sparkles: Sparkles,
  bot: Bot,
  route: Route,
  "key-round": KeyRound,
  "chart-line": ChartLine,
};

function resolveIcon(iconKey: string): LucideIcon {
  return ICON_MAP[iconKey] ?? Plug;
}

// Server returns "********" for secret values unless ?includeSecrets=true.
const SECRET_MASK_SENTINEL = "********";

interface DirtyField {
  value: string;
  markedForReplace?: boolean;
}

type DirtyState = Record<string, DirtyField>;

// Build the initial form state:
//  - Non-secret fields: pre-fill with the existing plaintext value (these are
//    harmless — channel names, emails, flags, etc.).
//  - Secret fields with an existing row: store the "********" sentinel so the
//    renderer shows masked read-only + Replace.
function buildInitialState(def: IntegrationDef, configs: SwarmConfig[]): DirtyState {
  const state: DirtyState = {};
  for (const f of def.fields) {
    const existing = findConfigForKey(configs, f.key);
    if (!existing) {
      state[f.key] = { value: f.default ?? "" };
      continue;
    }
    state[f.key] = {
      value: f.isSecret ? SECRET_MASK_SENTINEL : existing.value,
    };
  }
  return state;
}

export default function IntegrationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const def = useMemo(() => INTEGRATIONS.find((i) => i.id === id), [id]);

  const { data: configs, isLoading } = useConfigs({ scope: "global" });
  const upsertBatch = useUpsertConfigsBatch();
  const deleteBatch = useDeleteConfigsBatch();
  const reloadConfig = useReloadConfig();

  const envPresenceKeys = useMemo(() => {
    if (!def) return [];
    const keys = def.fields.map((f) => f.key);
    if (def.disableKey) keys.push(def.disableKey);
    return keys;
  }, [def]);
  const { data: envPresence } = useEnvPresence(envPresenceKeys);

  // Compute initial state only when configs/def land. We intentionally keep
  // local form state keyed by the catalog def id so navigating between
  // integrations resets cleanly via the `key` prop trick (see below).
  const initialState = useMemo(
    () => (def && configs ? buildInitialState(def, configs) : {}),
    [def, configs],
  );

  if (isLoading || !configs) return <PageSkeleton />;

  if (!def) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4 p-2">
        <EmptyState
          icon={Plug}
          title="Integration not found"
          description={`No integration matches "${id ?? ""}".`}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/integrations">← Back to integrations</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <IntegrationDetailInner
      key={def.id}
      def={def}
      configs={configs}
      initialState={initialState}
      upsertBatch={upsertBatch}
      deleteBatch={deleteBatch}
      reloadConfig={reloadConfig}
      envPresence={envPresence ?? {}}
    />
  );
}

interface InnerProps {
  def: IntegrationDef;
  configs: SwarmConfig[];
  initialState: DirtyState;
  upsertBatch: ReturnType<typeof useUpsertConfigsBatch>;
  deleteBatch: ReturnType<typeof useDeleteConfigsBatch>;
  reloadConfig: ReturnType<typeof useReloadConfig>;
  envPresence: EnvPresenceMap;
}

function IntegrationDetailInner({
  def,
  configs,
  initialState,
  upsertBatch,
  deleteBatch,
  reloadConfig,
  envPresence,
}: InnerProps) {
  const Icon = resolveIcon(def.iconKey);
  const status = deriveIntegrationStatus(def, configs, envPresence);

  const [state, setState] = useState<DirtyState>(initialState);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  function updateField(key: string, patch: Partial<DirtyField>) {
    setState((prev) => ({
      ...prev,
      [key]: { ...(prev[key] ?? { value: "" }), ...patch },
    }));
  }

  // A field is dirty when:
  //   - Secret + existing row + Replace clicked + non-mask value typed → send.
  //   - Secret + no existing row + non-empty value typed → send.
  //   - Non-secret + value differs from the stored value → send.
  function computeDirtyEntries(): UpsertConfigEntry[] {
    const entries: UpsertConfigEntry[] = [];
    for (const f of def.fields) {
      const current = state[f.key];
      if (!current) continue;
      const existing = findConfigForKey(configs, f.key);

      if (f.isSecret) {
        if (existing && !current.markedForReplace) continue;
        if (!current.value) continue;
        if (current.value === SECRET_MASK_SENTINEL) continue;
      } else {
        const prevValue = existing?.value ?? "";
        if (current.value === prevValue) continue;
      }

      entries.push({
        key: f.key,
        value: current.value,
        isSecret: f.isSecret === true,
        description: null,
        envPath: null,
        scope: "global",
      });
    }
    return entries;
  }

  const dirtyEntries = computeDirtyEntries();
  const hasDirty = dirtyEntries.length > 0;

  const handleSave = useCallback(async () => {
    if (!hasDirty) return;
    const saveResult = await upsertBatch.mutateAsync(dirtyEntries);
    if (saveResult.failureCount > 0) return; // upsertBatch already surfaced the error toast
    try {
      const reload = await reloadConfig.mutateAsync();
      const summary =
        reload.integrationsReinitialized.length > 0
          ? `Applied live to: ${reload.integrationsReinitialized.join(", ")}`
          : "Applied live (no integration re-init needed)";
      toast.success(summary);
    } catch {
      // reload hook surfaces its own error toast
    }
  }, [hasDirty, dirtyEntries, upsertBatch, reloadConfig]);

  // Cmd/Ctrl+S = Save. We intentionally let it fire even when focus is inside
  // a textarea (private keys, etc.) — users expect cmd+S universally and can
  // always fall back to the Save button if that shortcut is captured.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isSaveShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s";
      if (!isSaveShortcut) return;
      if (upsertBatch.isPending || reloadConfig.isPending) return;
      if (!hasDirty) return;
      e.preventDefault();
      void handleSave();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasDirty, upsertBatch.isPending, reloadConfig.isPending, handleSave]);

  function handleToggleDisable() {
    if (!def.disableKey) return;
    const current = findConfigForKey(configs, def.disableKey);
    const currentlyDisabled =
      !!current && ["true", "1", "yes"].includes(current.value.trim().toLowerCase());
    const nextValue = currentlyDisabled ? "false" : "true";
    upsertBatch.mutate([
      {
        key: def.disableKey,
        value: nextValue,
        isSecret: false,
        scope: "global",
      },
    ]);
  }

  function handleReset() {
    const keys = def.fields.map((f) => f.key);
    if (def.disableKey) keys.push(def.disableKey);
    deleteBatch.mutate({ configs, keys });
    setConfirmResetOpen(false);
  }

  async function handleClearField(key: string) {
    const row = configs.find((c) => c.scope === "global" && c.key === key);
    if (!row) return;
    await deleteBatch.mutateAsync({ configs, keys: [key] });
    try {
      await reloadConfig.mutateAsync();
    } catch {
      // reload hook surfaces its own error toast
    }
    // Reset local state for the field so the UI doesn't hold a stale value.
    setState((prev) => ({ ...prev, [key]: { value: "" } }));
  }

  const disableCfg = def.disableKey ? findConfigForKey(configs, def.disableKey) : undefined;
  const isDisabled =
    !!disableCfg && ["true", "1", "yes"].includes(disableCfg.value.trim().toLowerCase());

  const requiredFields = def.fields.filter(
    (f) => f.required === true || (f.advanced !== true && !f.required),
  );
  const advancedFields = def.fields.filter((f) => f.advanced === true);

  const isLinearOAuth = def.specialFlow === "linear-oauth";
  const isCodexCli = def.specialFlow === "codex-cli";
  const isGithub = def.id === "github";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-6 p-2">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <Button asChild size="sm" variant="ghost" className="self-start text-muted-foreground">
          <Link to="/integrations">← All integrations</Link>
        </Button>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted/50 shrink-0">
              <Icon className="h-6 w-6 text-foreground" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold">{def.name}</h1>
              <p className="text-sm text-muted-foreground">{def.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <IntegrationStatusBadge status={status} />
            <Button asChild size="sm" variant="outline" className="gap-1">
              <a href={def.docsUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" /> Docs
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Action bar — hidden for codex-cli (no catalog fields to save/reset via the generic flow). */}
      {!isCodexCli && (
        <div className="flex flex-wrap items-center gap-2 border border-border rounded-md p-3 bg-muted/20">
          <Button
            onClick={handleSave}
            disabled={!hasDirty || upsertBatch.isPending}
            className="bg-primary hover:bg-primary/90"
            size="sm"
          >
            {upsertBatch.isPending
              ? "Saving..."
              : hasDirty
                ? `Save ${dirtyEntries.length} change${dirtyEntries.length === 1 ? "" : "s"}`
                : "Save changes"}
          </Button>

          {def.disableKey && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleToggleDisable}
              disabled={upsertBatch.isPending}
            >
              {isDisabled ? "Enable" : "Disable"} {def.name}
            </Button>
          )}

          <div className="flex-1" />

          <Button
            type="button"
            variant="destructive-outline"
            size="sm"
            className="hover:text-red-300"
            onClick={() => setConfirmResetOpen(true)}
            disabled={deleteBatch.isPending}
          >
            Reset integration
          </Button>
        </div>
      )}

      {/* Linear OAuth connection card — shown ABOVE the generic form. */}
      {isLinearOAuth && <LinearOAuthSection />}

      {/* Body */}
      {isCodexCli ? (
        // Codex has zero catalog fields; swap the generic form entirely.
        <CodexOAuthSection />
      ) : def.fields.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No configurable fields"
          description="This integration has no key/value fields — see the docs for the required setup steps."
        />
      ) : (
        <div className="space-y-6">
          {isGithub && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                <p className="leading-relaxed">
                  <strong>PAT mode is the default and simpler path.</strong> For GitHub App
                  integration (recommended for production), expand <em>Advanced</em> below and fill{" "}
                  <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
                    GITHUB_APP_ID
                  </code>{" "}
                  +{" "}
                  <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
                    GITHUB_APP_PRIVATE_KEY
                  </code>
                  .
                </p>
              </AlertDescription>
            </Alert>
          )}

          {requiredFields.length > 0 && (
            <FieldGroup
              title="Required"
              fields={requiredFields}
              state={state}
              configs={configs}
              envPresence={envPresence}
              onUpdate={updateField}
              onClearField={handleClearField}
            />
          )}

          {advancedFields.length > 0 && (
            <details className="border border-border rounded-md">
              <summary className="cursor-pointer px-4 py-2 text-sm font-medium select-none">
                Advanced ({advancedFields.length})
              </summary>
              <div className="px-4 pb-4 pt-2">
                <FieldGroup
                  title=""
                  fields={advancedFields}
                  state={state}
                  configs={configs}
                  envPresence={envPresence}
                  onUpdate={updateField}
                  onClearField={handleClearField}
                  bare
                />
              </div>
            </details>
          )}
        </div>
      )}

      {/* Reset confirm dialog */}
      <AlertDialog open={confirmResetOpen} onOpenChange={setConfirmResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset {def.name} integration?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes every configuration key for this integration
              {def.disableKey ? ` (including ${def.disableKey})` : ""}. You'll be able to
              reconfigure from scratch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleReset}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface FieldGroupProps {
  title: string;
  fields: IntegrationField[];
  state: DirtyState;
  configs: SwarmConfig[];
  envPresence: EnvPresenceMap;
  onUpdate: (key: string, patch: Partial<DirtyField>) => void;
  onClearField: (key: string) => void;
  bare?: boolean;
}

function FieldGroup({
  title,
  fields,
  state,
  configs,
  envPresence,
  onUpdate,
  onClearField,
  bare,
}: FieldGroupProps) {
  const content = (
    <div className="space-y-5">
      {fields.map((f) => {
        const existing = findConfigForKey(configs, f.key);
        const current = state[f.key] ?? { value: "" };
        return (
          <FieldRenderer
            key={f.key}
            field={f}
            existingConfig={existing}
            inEnv={!!envPresence[f.key]}
            value={current.value}
            markedForReplace={!!current.markedForReplace}
            onChange={(v) => onUpdate(f.key, { value: v })}
            onMarkForReplace={() => onUpdate(f.key, { value: "", markedForReplace: true })}
            onUnmarkForReplace={() =>
              onUpdate(f.key, { value: SECRET_MASK_SENTINEL, markedForReplace: false })
            }
            onClearExisting={existing ? () => onClearField(f.key) : undefined}
          />
        );
      })}
    </div>
  );

  if (bare) return content;

  return (
    <section className="space-y-3">
      {title && (
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          {title}
        </h2>
      )}
      {content}
    </section>
  );
}
