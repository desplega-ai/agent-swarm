import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BrandLogo, SetupCard, SetupChip, type SetupChipTone } from "../components/setup-card";
import type { StepProps } from "../step-contract";
import {
  ALL_SETUP_KEYS,
  connectedMethod,
  findSetupIntegration,
  SETUP_INTEGRATIONS,
  type SetupIntegration,
  type SetupIntegrationId,
} from "./integrations/catalog";
import { GitHubPane, GitLabPane } from "./integrations/git-panes";
import { JiraPane, LinearPane } from "./integrations/oauth-panes";
import { SlackPane } from "./integrations/slack-pane";
import type { PaneProps } from "./integrations/use-config-form";

/** Query params the Linear/Jira OAuth return adds to `/setup?step=5`. */
const RETURN_PARAMS = ["integration", "oauth", "error", "error_description"];

export function StepIntegrations({ onboarding, act }: StepProps) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<SetupIntegrationId>(
    () => findSetupIntegration(searchParams.get("integration"))?.id ?? "slack",
  );
  const [oauthError, setOauthError] = useState<{ id: SetupIntegrationId; message: string } | null>(
    null,
  );
  const configsQ = useConfigs({ scope: "global" });
  const presenceQ = useEnvPresence(ALL_SETUP_KEYS);
  const configs = configsQ.data ?? [];
  const presence = presenceQ.data ?? {};
  const signals = onboarding.signals.integrations;

  // Linear/Jira land back here after OAuth: report the result once, then
  // strip the params so a refresh does not repeat it.
  const handledReturn = useRef(false);
  useEffect(() => {
    if (handledReturn.current) return;
    const returned = findSetupIntegration(searchParams.get("integration"));
    const oauth = searchParams.get("oauth");
    if (!returned && !oauth) return;
    handledReturn.current = true;
    if (returned && oauth === "success") {
      toast.success(`${returned.name} connected.`);
      void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: [returned.id, "tracker", "status"] });
    } else if (returned && oauth === "error") {
      const message =
        searchParams.get("error_description") ?? searchParams.get("error") ?? "Unknown error";
      setOauthError({ id: returned.id, message });
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of RETURN_PARAMS) next.delete(key);
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams, queryClient]);

  // Record the precise method once the first integration connects. The API
  // also derives it on read, so a failed call needs no retry.
  const method = connectedMethod(signals);
  const stepStatus = onboarding.state.steps.integrations.status;
  const completeSent = useRef(false);
  useEffect(() => {
    if (!method || stepStatus === "done" || completeSent.current) return;
    completeSent.current = true;
    act({ action: "complete", step: "integrations", method }).catch(() => undefined);
  }, [method, stepStatus, act]);

  function chip(item: SetupIntegration): { tone: SetupChipTone; label: string } {
    if (signals[item.id]) return { tone: "success", label: "Connected" };
    const saved = item.chipKeys.some(
      (key) => presence[key] || configs.some((c) => c.key === key && c.scope === "global"),
    );
    return saved ? { tone: "pending", label: "Saved" } : { tone: "neutral", label: "Not set" };
  }

  const selected = findSetupIntegration(selectedId) ?? SETUP_INTEGRATIONS[0];
  const selectedChip = chip(selected);
  const paneProps = { configs, presence, connected: signals[selected.id] };
  const paneError = oauthError?.id === selected.id ? oauthError.message : null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)] sm:items-start">
        <nav
          aria-label="Integrations"
          className="flex gap-2 overflow-x-auto pb-1 sm:flex-col sm:gap-0 sm:divide-y sm:divide-border-subtle sm:overflow-hidden sm:rounded-xl sm:border sm:bg-card sm:pb-0 sm:shadow-sm"
        >
          {SETUP_INTEGRATIONS.map((item) => {
            const active = item.id === selected.id;
            const itemChip = chip(item);
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedId(item.id)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-sm hover:bg-accent/50 hover-linger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  "sm:h-auto sm:rounded-none sm:border-0 sm:border-l-2 sm:border-l-transparent sm:py-2.5 sm:pr-3 sm:pl-2.5",
                  active && "border-primary/60 bg-primary/5 font-medium sm:border-l-primary",
                )}
              >
                <BrandLogo src={item.logo} className="size-4" />
                <span className="flex-1 text-left">{item.name}</span>
                <span className="hidden sm:inline-flex">
                  <SetupChip tone={itemChip.tone}>{itemChip.label}</SetupChip>
                </span>
              </button>
            );
          })}
          <Link
            to="/settings/integrations"
            className="flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-sm text-muted-foreground hover:text-foreground hover-linger sm:h-auto sm:items-start sm:rounded-none sm:border-0 sm:px-3 sm:py-2.5"
          >
            <ExternalLink className="size-4 shrink-0 sm:mt-0.5" />
            <span className="flex flex-col">
              <span className="font-medium">More in Settings</span>
              <span className="hidden text-xs sm:block">
                Attio, Sentry, AgentMail, agent-fs, and the rest.
              </span>
            </span>
          </Link>
        </nav>

        <SetupCard
          icon={<BrandLogo src={selected.logo} />}
          title={selected.name}
          description={selected.purpose}
          actions={
            <a
              href={selected.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Docs
              <ExternalLink className="size-3" />
            </a>
          }
          status={<SetupChip tone={selectedChip.tone}>{selectedChip.label}</SetupChip>}
          bodyClassName="space-y-4"
        >
          {configsQ.isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          ) : (
            <IntegrationPane
              key={selected.id}
              id={selected.id}
              paneProps={paneProps}
              oauthError={paneError}
            />
          )}
        </SetupCard>
      </div>
      <p className="text-xs text-muted-foreground">One connected tool finishes this step.</p>
    </div>
  );
}

function IntegrationPane({
  id,
  paneProps,
  oauthError,
}: {
  id: SetupIntegrationId;
  paneProps: PaneProps;
  oauthError: string | null;
}) {
  switch (id) {
    case "slack":
      return <SlackPane {...paneProps} />;
    case "github":
      return <GitHubPane {...paneProps} />;
    case "gitlab":
      return <GitLabPane {...paneProps} />;
    case "linear":
      return <LinearPane {...paneProps} oauthError={oauthError} />;
    case "jira":
      return <JiraPane {...paneProps} oauthError={oauthError} />;
  }
}
