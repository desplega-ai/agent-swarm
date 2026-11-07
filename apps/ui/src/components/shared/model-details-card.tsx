import type { ReactNode } from "react";
import { useState } from "react";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import { useTask } from "@/api/hooks/use-tasks";
import type { AgentTask, ModelProfile } from "@/api/types";
import { EffortMark } from "@/components/shared/effort-mark";
import { HarnessIcon } from "@/components/shared/harness-icon";
import { ModelLogo } from "@/components/shared/model-logo";
import { REASONING_EFFORT_LABEL } from "@/components/shared/reasoning-effort-icon";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Skeleton } from "@/components/ui/skeleton";
import { findKnownModel, type LiveModelsCatalog } from "@/lib/agent-runtime-models";
import { formatCost } from "@/lib/cost-format";
import { modelTierLabel } from "@/lib/model-tiers";
import { modelDisplayName } from "@/lib/model-vendor";
import {
  isSeededTaskProfile,
  modelSourceLabel,
  taskDisplayEffort,
  taskDisplayModel,
  taskDisplayProfile,
} from "@/lib/task-model-resolution";
import { cn } from "@/lib/utils";

export type ModelDetailsTask = Pick<
  AgentTask,
  | "id"
  | "model"
  | "modelTier"
  | "resolvedModel"
  | "modelSource"
  | "modelAlias"
  | "profile"
  | "resolvedProfile"
  | "effort"
  | "resolvedEffort"
  | "provider"
  | "totalCostUsd"
  | "credentialKeyType"
  | "credentialKeySuffix"
>;

/** Credential types billed as a flat subscription (`SUBSCRIPTION_KEY_TYPES` on the API). */
const CREDENTIAL_LABELS: Record<string, { label: string; kind: "Subscription" | "API key" }> = {
  CLAUDE_CODE_OAUTH_TOKEN: { label: "Claude subscription", kind: "Subscription" },
  CODEX_OAUTH: { label: "ChatGPT subscription", kind: "Subscription" },
  ANTHROPIC_API_KEY: { label: "Anthropic", kind: "API key" },
  OPENAI_API_KEY: { label: "OpenAI", kind: "API key" },
  OPENROUTER_API_KEY: { label: "OpenRouter", kind: "API key" },
};

/** "Claude subscription", "OpenRouter API key"; unknown types keep their variable name. */
export function credentialLabel(keyType: string): string {
  const known = CREDENTIAL_LABELS[keyType];
  if (!known) return keyType;
  return known.kind === "Subscription" ? known.label : `${known.label} API key`;
}

/** The credential variables a harness can run this model on. Empty when unknown. */
export function acceptedCredentials(
  harness: string | undefined,
  catalogKey: string | undefined,
): string[] {
  if (harness === "claude") return ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  if (harness === "codex") {
    return catalogKey === "CODEX_OAUTH" ? ["CODEX_OAUTH"] : ["CODEX_OAUTH", "OPENAI_API_KEY"];
  }
  return catalogKey ? [catalogKey] : [];
}

function costOf(value: number): string {
  return formatCost(value, { precision: value > 0 && value < 1 ? 4 : "auto" });
}

const UNKNOWN = <span className="text-muted-foreground">Unknown</span>;

/**
 * The model behind a task as a hover card: the model, the profile that picked
 * it, what it cost and which credential served it. Opens on pointer hover, on
 * keyboard focus and on click (touch), and portals out of the grid so the row
 * never clips it. The credential comes from the task detail, read once on open.
 */
export function ModelDetailsCard({
  task,
  profile,
  catalog,
  label,
  children,
}: {
  task: ModelDetailsTask;
  profile?: ModelProfile;
  catalog?: LiveModelsCatalog;
  /** Accessible name of the trigger. */
  label: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={`Model details: ${label}`}
          aria-expanded={open}
          className="inline-flex min-w-0 max-w-full cursor-default items-center rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={(e) => {
            // The row navigates on click; a tap here opens the card instead.
            e.stopPropagation();
            setOpen(true);
          }}
        >
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        collisionPadding={8}
        className="w-[22rem] max-w-[calc(100vw-1rem)] divide-y divide-border-subtle p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <LiveModelDetails task={task} profile={profile} catalog={catalog} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** Reads the credential from the task detail; the list row does not carry it. */
function LiveModelDetails({
  task,
  profile,
  catalog,
}: {
  task: ModelDetailsTask;
  profile?: ModelProfile;
  catalog?: LiveModelsCatalog;
}) {
  const { data: detail, isLoading } = useTask(task.id ?? "", { refetchInterval: false });
  const { data: liveCatalog } = useModelsCatalog();
  return (
    <ModelDetails
      task={{ ...task, ...pickCredential(detail ?? task) }}
      profile={profile}
      catalog={catalog ?? liveCatalog?.providers}
      credentialLoading={isLoading && !task.credentialKeyType}
    />
  );
}

function pickCredential(
  task: Partial<Pick<AgentTask, "credentialKeyType" | "credentialKeySuffix">>,
) {
  return {
    credentialKeyType: task.credentialKeyType,
    credentialKeySuffix: task.credentialKeySuffix,
  };
}

/** The card body. Pure, so tests render it without the hover machinery. */
export function ModelDetails({
  task,
  profile,
  catalog,
  credentialLoading = false,
}: {
  task: Partial<ModelDetailsTask>;
  profile?: ModelProfile;
  catalog?: LiveModelsCatalog;
  credentialLoading?: boolean;
}) {
  const model = taskDisplayModel(task);
  const effort = taskDisplayEffort(task);
  const profileName = taskDisplayProfile(task);
  const known = findKnownModel(model, catalog);
  const harness = profile?.harness ?? task.provider;
  const accepted = acceptedCredentials(harness, known?.requiredKey);
  const pinned = profile?.credentials ? Object.keys(profile.credentials) : [];
  const rate = known?.cost;

  return (
    <>
      <div className="flex items-start gap-2.5 px-4 py-3">
        <ModelLogo model={model} className="mt-0.5 size-4" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-medium leading-5">
            <span className="break-words">
              {model ? modelDisplayName(model, catalog) : "Not resolved yet"}
            </span>
            <EffortMark effort={effort} className="text-muted-foreground" />
          </p>
          <p className="mt-0.5 text-meta text-muted-foreground">
            {known?.provider ?? "Unknown provider"}
            {model ? (
              <>
                {" · "}
                <span className="font-mono">{model}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      <dl className="px-4 py-2.5">
        <Row label="Profile">
          {profileName ? (
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{profileName}</span>
                <Badge variant="outline" size="tag" className="shrink-0 normal-case">
                  {isSeededTaskProfile(task, profile) ? "seeded" : "custom"}
                </Badge>
              </span>
              <span className="flex min-w-0 items-start gap-1 text-xs leading-5 text-muted-foreground">
                {profile ? (
                  <>
                    <HarnessIcon harness={profile.harness} className="mt-1 size-3" />
                    <span className="min-w-0 font-mono wrap-anywhere">
                      {[profile.harness, profile.model, profile.effort ?? "default effort"].join(
                        " · ",
                      )}
                    </span>
                  </>
                ) : (
                  "Definition unknown"
                )}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </Row>
        <Row label="Effort">
          {effort ? (
            REASONING_EFFORT_LABEL[effort]
          ) : (
            <span className="text-muted-foreground">Default</span>
          )}
        </Row>
        <Row label="Chosen by">
          {task.modelSource ? (
            <span title={task.modelSource}>{modelSourceLabel(task.modelSource)}</span>
          ) : (
            UNKNOWN
          )}
        </Row>
        {task.modelTier ? <Row label="Tier">{modelTierLabel(task.modelTier)}</Row> : null}
        {task.modelAlias ? (
          <Row label="Alias" mono>
            {task.modelAlias}
          </Row>
        ) : null}
      </dl>

      <dl className="px-4 py-2.5">
        <Row label="Task cost" mono>
          {task.totalCostUsd != null ? costOf(task.totalCostUsd) : UNKNOWN}
        </Row>
        <Row label="Rate / 1M" mono>
          {rate?.input != null && rate.output != null ? (
            <span>
              {costOf(rate.input)} in · {costOf(rate.output)} out
            </span>
          ) : (
            UNKNOWN
          )}
        </Row>
      </dl>

      <dl className="px-4 py-2.5">
        <Row label="Served by">
          {credentialLoading ? (
            <Skeleton aria-label="Loading credential" className="h-3.5 w-32" />
          ) : task.credentialKeyType ? (
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{credentialLabel(task.credentialKeyType)}</span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {task.credentialKeyType}
                {task.credentialKeySuffix ? ` …${task.credentialKeySuffix}` : ""}
              </span>
            </span>
          ) : (
            UNKNOWN
          )}
        </Row>
        <Row label="Accepts" mono>
          {accepted.length > 0 ? (
            <span className="block text-xs leading-5 wrap-anywhere">{accepted.join(", ")}</span>
          ) : (
            UNKNOWN
          )}
        </Row>
        {pinned.length > 0 ? (
          <Row label="Pinned to" mono>
            <span className="block text-xs leading-5 wrap-anywhere">{pinned.join(", ")}</span>
          </Row>
        ) : null}
      </dl>
    </>
  );
}

function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-x-3 py-0.5">
      <dt className="text-xs leading-5 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 text-data leading-5", mono && "font-mono tabular-nums")}>
        {children}
      </dd>
    </div>
  );
}
