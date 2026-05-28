"use client";

import {
  BadgeCheck,
  Calendar,
  Check,
  Copy,
  GitBranch,
  MessageSquareQuote,
  Wrench,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Badge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { WorkflowGraph, type WorkflowDefinitionLike } from "@/components/workflow-graph";
import { cn } from "@/lib/utils";
import type { AgentAssetKind, AgentAssetResponse } from "../../../templates/schema";

const kindIcons = {
  skill: Wrench,
  schedule: Calendar,
  workflow: GitBranch,
} satisfies Record<AgentAssetKind, React.ComponentType<{ className?: string }>>;

const kindLabels: Record<AgentAssetKind, string> = {
  skill: "Skill",
  schedule: "Schedule",
  workflow: "Workflow",
};

function buildPromptForLead(asset: AgentAssetResponse["config"], pageUrl: string): string {
  const { kind, displayName, slug, placeholders } = asset;
  const placeholderNote =
    placeholders.length > 0
      ? `\nReplace these placeholders before installing: ${placeholders.join(", ")}.`
      : "";

  if (kind === "skill") {
    return `Install the "${displayName}" skill from the templates registry.\n\nReference: ${pageUrl}${placeholderNote}\n\nOnce installed, worker agents can invoke it during tasks.`;
  }

  if (kind === "schedule") {
    return `Create a new schedule using the "${displayName}" template.\n\nReference: ${pageUrl}${placeholderNote}\n\nCopy the JSON payload from the template, fill in the placeholders, and run:\ncreate-schedule --from-template ${slug}`;
  }

  return `Create a workflow using the "${displayName}" template.\n\nReference: ${pageUrl}${placeholderNote}\n\nCopy the workflow JSON from the template and run:\ncreate-workflow --from-template ${slug}`;
}

/**
 * Pull the first ```json fenced block out of the markdown body. Returns the
 * parsed definition, the pretty-printed JSON, and the markdown with the block
 * removed so prose can be rendered around the graph. Falls back to nulls when
 * there is no parseable JSON block.
 */
function extractWorkflowJson(body: string): {
  definition: WorkflowDefinitionLike | null;
  prettyJson: string | null;
  rest: string;
} {
  const match = body.match(/```json\n([\s\S]*?)```/);
  if (!match) return { definition: null, prettyJson: null, rest: body };

  try {
    const parsed = JSON.parse(match[1]) as WorkflowDefinitionLike;
    const prettyJson = JSON.stringify(parsed, null, 2);
    const rest = body.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim();
    return { definition: parsed, prettyJson, rest };
  } catch {
    return { definition: null, prettyJson: null, rest: body };
  }
}

/** Small copy-to-clipboard button with a transient "Copied!" state. */
function CopyButton({
  text,
  label,
  copiedLabel = "Copied!",
  className,
}: {
  text: string;
  label: string;
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can reject (e.g. insecure context) — fail silently.
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
        className,
      )}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? copiedLabel : label}
    </button>
  );
}

/** "Prompt for the Lead" — a button that copies on open and reveals the prompt. */
function PromptForLeadPopover({ promptText, kindLabel }: { promptText: string; kindLabel: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failures
    }
  }, [promptText]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) void copy();
    },
    [copy],
  );

  return (
    <Popover.Root onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
        >
          <MessageSquareQuote className="h-4 w-4" />
          Prompt for the Lead
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none"
        >
          <p className="mb-2 text-xs text-muted-foreground">
            Hand this to your Lead agent to install or create this {kindLabel.toLowerCase()}.
          </p>
          <div className="max-h-80 overflow-y-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {promptText}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {copied && (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Copied to clipboard
                </>
              )}
            </span>
            <CopyButton text={promptText} label="Copy again" className="px-2.5 py-1 text-xs" />
          </div>
          <Popover.Arrow className="fill-border" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface AssetDetailProps {
  asset: AgentAssetResponse;
  category: string;
  name: string;
}

export function AssetDetail({ asset, category, name }: AssetDetailProps) {
  const pageUrl = `https://templates.agent-swarm.dev/${category}/${name}`;
  const promptText = buildPromptForLead(asset.config, pageUrl);
  const Icon = kindIcons[asset.config.kind];
  const kindLabel = kindLabels[asset.config.kind];

  const isWorkflow = asset.config.kind === "workflow";
  const { definition, prettyJson, rest } = useMemo(
    () => (isWorkflow ? extractWorkflowJson(asset.body) : { definition: null, prettyJson: null, rest: asset.body }),
    [isWorkflow, asset.body],
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <h1 className="text-3xl font-bold">{asset.config.displayName}</h1>
          <Badge variant="secondary">{kindLabel}</Badge>
          <Badge variant="outline">v{asset.config.version}</Badge>
          {asset.config.must === true && (
            <Badge variant="default" className="gap-1">
              <BadgeCheck className="h-3.5 w-3.5" />
              Must-have
            </Badge>
          )}
          <div className="ml-auto">
            <PromptForLeadPopover promptText={promptText} kindLabel={kindLabel} />
          </div>
        </div>
        <p className="mb-4 text-lg text-muted-foreground">{asset.config.description}</p>
        <div className="flex flex-wrap gap-1.5">
          {asset.config.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
        {asset.config.placeholders.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Placeholders to fill:</span>
            {asset.config.placeholders.map((p) => (
              <code key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {`{{${p}}}`}
              </code>
            ))}
          </div>
        )}
      </div>

      {/* Workflow graph */}
      {isWorkflow && definition && (
        <div>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Workflow</h2>
            {prettyJson && (
              <CopyButton text={prettyJson} label="Copy workflow JSON" />
            )}
          </div>
          <WorkflowGraph definition={definition} />
        </div>
      )}

      {/* Content */}
      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Template Content</h2>
          <CopyButton text={asset.body} label="Copy contents" />
        </div>
        <div className="rounded-lg border border-border bg-card/50 p-6">
          <Markdown>{isWorkflow && definition ? rest : asset.body}</Markdown>
        </div>
      </div>
    </div>
  );
}
