import { Check, ChevronDown, MessageCircle, MessagesSquare, Plus } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router-dom";
import { useChatSdkStatus } from "@/api/hooks/use-chat-sdk";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { ChannelStatusChip } from "@/components/integrations/channel-status-chip";
import { BetaTag } from "@/components/shared/beta-tag";
import { BrandLogo } from "@/components/shared/brand-logo";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import {
  CHANNEL_DEFS,
  type ChannelDef,
  type ChannelState,
  chatSdkAdapterHref,
  deriveChannelStates,
  matchChannels,
} from "@/lib/channel-cards";
import { getPresenceKeys, INTEGRATIONS } from "@/lib/integrations-catalog";
import { cn } from "@/lib/utils";
import { ConnectPhoneTitle, ConnectSearch, ConnectToolbar } from "./connect-shell";

/** Env keys that can make the socket-mode Slack or Kapso card connected. */
const PRESENCE_KEYS = INTEGRATIONS.filter(
  (def) => def.id === "slack" || def.id === "kapso",
).flatMap(getPresenceKeys);

/** Connect › Channels: where people talk to the swarm. */
export default function ChannelsPage() {
  const { searchParams } = useUrlSearchState();
  const search = readStringParam(searchParams, "search");
  const configs = useConfigs({ scope: "global" });
  const { data: envPresence } = useEnvPresence(PRESENCE_KEYS);
  const chatSdk = useChatSdkStatus({ poll: false });
  const states = useMemo(
    () =>
      deriveChannelStates({
        configs: configs.data ?? [],
        envPresence: envPresence ?? {},
        chatSdk: chatSdk.data,
      }),
    [configs.data, envPresence, chatSdk.data],
  );
  const shown = matchChannels(CHANNEL_DEFS, search);
  const main = shown.filter((def) => !def.more);
  const more = shown.filter((def) => def.more);
  const loadError = configs.error ?? chatSdk.error;

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-y-auto gap-4">
      <ConnectPhoneTitle title="Channels" />
      <ConnectToolbar>
        <ConnectSearch placeholder="Search channels" />
        <ConnectChannelMenu />
      </ConnectToolbar>
      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load channel status:{" "}
            {loadError instanceof Error ? loadError.message : String(loadError)}
          </AlertDescription>
        </Alert>
      ) : null}
      {configs.isLoading || chatSdk.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {CHANNEL_DEFS.filter((def) => !def.more).map((def) => (
            <Skeleton key={def.id} className="h-36" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={MessagesSquare} title="Nothing matches your search" compact />
      ) : (
        <>
          {main.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {main.map((def) => (
                <ChannelCard key={def.id} def={def} state={states[def.id]}>
                  {def.id === "slack" && <SlackModes state={states.slack} />}
                </ChannelCard>
              ))}
            </div>
          )}
          {more.length > 0 && (
            <section aria-labelledby="more-channels" className="flex flex-col gap-2">
              <h2 id="more-channels" className="text-xs font-medium text-muted-foreground">
                More channels
              </h2>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {more.map((def) => (
                  <ChannelRow key={def.id} def={def} state={states[def.id]} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ChannelLogo({ def, small }: { def: ChannelDef; small?: boolean }) {
  const mark = small ? "size-4" : "size-5";
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-muted/50",
        small ? "size-7" : "size-9",
      )}
    >
      {def.logoSrc ? (
        <BrandLogo src={def.logoSrc} className={cn(mark, "text-foreground")} />
      ) : (
        <MessageCircle className={cn(mark, "text-foreground")} aria-hidden />
      )}
    </div>
  );
}

function actionLabel(state: ChannelState): string {
  return state.chip === "none" ? "Connect" : "Manage";
}

/** Slack goes to the page of the mode in use; socket mode when none is. */
function hrefFor(def: ChannelDef, state: ChannelState): string {
  if (def.id === "slack" && state.slackMode === "chat-sdk") return chatSdkAdapterHref("slack");
  return def.href;
}

/** The footer line: why it does not run, the mode in use, or what connecting needs. */
function footerText(def: ChannelDef, state: ChannelState): string {
  if (state.detail) return state.detail;
  if (def.id === "slack" && state.chip === "connected") {
    return state.slackMode === "chat-sdk" ? "Chat SDK adapter" : "Socket mode";
  }
  if (state.chip === "connected") return "Running";
  return def.needs;
}

function ChannelCard({
  def,
  state,
  children,
}: {
  def: ChannelDef;
  state: ChannelState;
  children?: ReactNode;
}) {
  const footer = footerText(def, state);
  const action = actionLabel(state);
  return (
    <Card className="gap-3 py-4" data-channel-id={def.id}>
      <CardContent className="flex flex-1 flex-col gap-3 px-4">
        <div className="flex items-start gap-3">
          <ChannelLogo def={def} />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold">{def.name}</h3>
            <p className="text-xs text-muted-foreground">{def.description}</p>
          </div>
          <ChannelStatusChip chip={state.chip} />
        </div>
        {children}
        <div className="mt-auto flex items-center gap-3 pt-1">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs text-muted-foreground",
              state.chip === "configured" && "text-status-active-strong",
            )}
            title={footer}
          >
            {footer}
          </span>
          <Button asChild size="xs" variant="outline">
            <Link to={hrefFor(def, state)} aria-label={`${action} ${def.name}`}>
              {action}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The two ways into Slack, with the one in use checked. */
function SlackModes({ state }: { state: ChannelState }) {
  const active = state.chip === "none" ? undefined : state.slackMode;
  return (
    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
      <SlackMode active={active === "socket"}>
        <span className="font-medium text-foreground">Socket mode</span>: the swarm's own Slack bot.
        Recommended.
      </SlackMode>
      <SlackMode active={active === "chat-sdk"}>
        <Link
          to={chatSdkAdapterHref("slack")}
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Chat SDK adapter
        </Link>
        : Slack on the shared channel SDK, next to Telegram and Discord.{" "}
        <BetaTag
          tooltip="Tested only against fixtures so far, not a real workspace."
          side="top"
          className="align-middle"
        />
      </SlackMode>
    </ul>
  );
}

function SlackMode({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-1.5">
      <Check
        className={cn(
          "mt-0.5 size-3 shrink-0",
          active ? "text-status-success-strong" : "text-transparent",
        )}
        aria-hidden
      />
      <span>
        {active && <span className="sr-only">In use: </span>}
        {children}
      </span>
    </li>
  );
}

/** A compact "More channels" entry: logo, name, state and the action on one line. */
function ChannelRow({ def, state }: { def: ChannelDef; state: ChannelState }) {
  const action = actionLabel(state);
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
      data-channel-id={def.id}
    >
      <ChannelLogo def={def} small />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-medium">{def.name}</h3>
          {def.beta && <BetaTag tooltip={def.beta} side="top" />}
        </div>
        <p className="truncate text-xs text-muted-foreground" title={state.detail}>
          {state.detail ?? def.description}
        </p>
      </div>
      <ChannelStatusChip chip={state.chip} className="hidden sm:inline-flex" />
      <Button asChild size="xs" variant="outline">
        <Link to={def.href} aria-label={`${action} ${def.name}`}>
          {action}
        </Link>
      </Button>
    </div>
  );
}

/** The primary action: the same channels as the cards, for people who look for a button. */
function ConnectChannelMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="shrink-0">
          <Plus className="size-4" />
          Connect a channel
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {CHANNEL_DEFS.map((def) => (
          <DropdownMenuItem key={def.id} asChild>
            <Link to={def.href}>{def.name}</Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/integrations/chat-sdk">All Chat SDK adapters</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
