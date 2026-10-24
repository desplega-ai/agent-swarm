import { Check, ChevronRight, Copy } from "lucide-react";
import { isValidElement, type ReactNode, useState } from "react";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { CHAT_SDK_ADAPTER_DEFS, type ChatSdkAdapterName } from "@/lib/chat-sdk-fields";
import { DISCORD_INVITE_PERMISSIONS } from "@/lib/chat-sdk-form";
import { cn } from "@/lib/utils";

// Setup steps for each Chat SDK adapter panel. The docs page
// (docs-site/.../integrations/chat-sdk.mdx, "Platform setup") is the source of
// truth: keep these steps in line with it.

/** Inline mono chip. `breakable` lets a long key wrap inside the chip only. */
export function CodeChip({ children, breakable }: { children: ReactNode; breakable?: boolean }) {
  return (
    <code
      className={cn(
        breakable ? "break-all" : "whitespace-nowrap",
        "rounded bg-muted px-1 py-0.5 font-mono text-xs",
      )}
    >
      {children}
    </code>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline underline-offset-2 hover:text-primary"
    >
      {children}
    </a>
  );
}

/** Heading anchors of the "Platform setup" sections on the docs page. */
const DOCS_ANCHOR: Record<ChatSdkAdapterName, string> = {
  telegram: "telegram",
  slack: "slack",
  discord: "discord",
  teams: "microsoft-teams",
};

const SLACK_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "users:read",
  "files:read",
];

const SLACK_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
];

function chipList(items: string[]): ReactNode {
  return items.map((item, index) => (
    <span key={item}>
      {index > 0 && ", "}
      <CodeChip>{item}</CodeChip>
    </span>
  ));
}

interface StepContext {
  docsUrl: string | undefined;
  /** Discord: the OAuth2 invite link, once an application id is known. */
  inviteUrl: string | undefined;
}

function steps(adapter: ChatSdkAdapterName, { docsUrl, inviteUrl }: StepContext): ReactNode[] {
  const docsLink = (label: string) =>
    docsUrl ? (
      <ExternalLink href={`${docsUrl}#${DOCS_ANCHOR[adapter]}`}>{label}</ExternalLink>
    ) : (
      label
    );
  switch (adapter) {
    case "telegram":
      return [
        <>
          In Telegram, open <ExternalLink href="https://t.me/BotFather">BotFather</ExternalLink> and
          send <CodeChip>/newbot</CodeChip>. Copy the token into <b>Bot token</b>.
        </>,
        <>
          Pick a mode. <b>Polling</b> needs no public URL and is good for local work. <b>Webhook</b>{" "}
          needs a public HTTPS URL on port 443, 80, 88 or 8443.
        </>,
        <>
          Webhook mode only: enter a random <b>Webhook secret token</b> (letters, digits,{" "}
          <CodeChip>_</CodeChip> and <CodeChip>-</CodeChip>, up to 256 characters).
        </>,
        <>
          Optional: enter the Telegram user ids allowed to use the bot. Leave it blank to allow
          everyone.
        </>,
        <>Turn on Telegram and save. The adapter starts within a few seconds.</>,
        <>
          Webhook mode only: click <b>Register webhook</b> below. In polling mode, do not register a
          webhook.
        </>,
        <>
          In a group, the bot sees only commands and mentions. To let it see every message, send{" "}
          <CodeChip>/setprivacy</CodeChip> to BotFather, turn privacy off, then add the bot to the
          group again.
        </>,
        <>
          The bot answers <CodeChip>/help</CodeChip>, <CodeChip>/status</CodeChip>,{" "}
          <CodeChip>/cancel</CodeChip> and <CodeChip>/reset</CodeChip>. The command menu is
          published to Telegram each time the adapter starts.
        </>,
      ];
    case "slack":
      return [
        <>
          Experimental: this adapter has run only against fixtures, not a real workspace. Report
          gaps on{" "}
          <ExternalLink href="https://github.com/desplega-ai/agent-swarm/issues/2149">
            issue #2149
          </ExternalLink>
          .
        </>,
        <>
          Turn off the built-in Slack integration: set <CodeChip>SLACK_DISABLE=true</CodeChip>.
        </>,
        <>
          Create an app at{" "}
          <ExternalLink href="https://api.slack.com/apps">api.slack.com/apps</ExternalLink> (
          <b>From a manifest</b>). Start from the manifest in the {docsLink("Chat SDK docs")}.
        </>,
        <>Bot scopes: {chipList(SLACK_SCOPES)}.</>,
        <>Bot events: {chipList(SLACK_EVENTS)}.</>,
        <>
          Pick a mode. <b>Socket:</b> turn on Socket Mode and create an app-level token (
          <CodeChip>xapp-...</CodeChip>) with <CodeChip>connections:write</CodeChip>. No public URL
          is needed. <b>Webhook:</b> set the Event Subscriptions request URL to the URL below, and
          copy the signing secret.
        </>,
        <>
          Install the app to the workspace and copy the bot token (<CodeChip>xoxb-...</CodeChip>).
        </>,
        <>Turn on Slack, enter the values, and save.</>,
        <>
          Optional: under <b>Slash Commands</b>, add <CodeChip>/help</CodeChip>,{" "}
          <CodeChip>/status</CodeChip>, <CodeChip>/cancel</CodeChip> and <CodeChip>/reset</CodeChip>
          . In webhook mode, the request URL is the URL below. The {docsLink("Chat SDK docs")} have
          the manifest entries.
        </>,
      ];
    case "discord":
      return [
        <>
          Create an application in the{" "}
          <ExternalLink href="https://discord.com/developers/applications">
            Discord Developer Portal
          </ExternalLink>
          . Copy the <b>Application ID</b> and the <b>Public Key</b>.
        </>,
        <>
          On the <b>Bot</b> page, copy the bot token. Turn on the <b>Message Content</b> privileged
          intent: without it, mentions create no task.
        </>,
        <>
          Invite the bot to your server:{" "}
          {inviteUrl ? (
            <ExternalLink href={inviteUrl}>open the invite link</ExternalLink>
          ) : (
            <>enter the Application ID above to get the invite link</>
          )}
          . It uses the <CodeChip>bot</CodeChip> and <CodeChip>applications.commands</CodeChip>{" "}
          scopes with permissions <CodeChip>{DISCORD_INVITE_PERMISSIONS}</CodeChip> (View Channels,
          Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read
          Message History, Add Reactions, Attach Files, Embed Links). Until the bot is in a server
          it never receives a message.
        </>,
        <>
          Optional, for <CodeChip>/help</CodeChip>, <CodeChip>/status</CodeChip>,{" "}
          <CodeChip>/cancel</CodeChip> and <CodeChip>/reset</CodeChip>: set{" "}
          <b>Interactions Endpoint URL</b> to the URL below, then register the commands once with
          the Discord API. The {docsLink("Chat SDK docs")} have the command. Messages arrive over
          the Gateway, so without it the bot still answers mentions.
        </>,
        <>Turn on Discord, enter the values, and save.</>,
      ];
    case "teams":
      return [
        <>
          Experimental: this adapter has run only against fixtures, not a real workspace. Report
          gaps on{" "}
          <ExternalLink href="https://github.com/desplega-ai/agent-swarm/issues/2149">
            issue #2149
          </ExternalLink>
          .
        </>,
        <>
          In Azure, create an <b>Azure Bot</b> resource. Pick Multi Tenant or Single Tenant (
          <b>App type</b>).
        </>,
        <>
          Copy the Microsoft App ID into <b>App ID</b>. Create a client secret and enter it as{" "}
          <b>App password</b>.
        </>,
        <>
          Single tenant only: copy the tenant id into <b>Tenant ID</b>.
        </>,
        <>
          Set the bot's <b>Messaging endpoint</b> to the URL below.
        </>,
        <>Add the Microsoft Teams channel to the bot, and install the bot in Teams.</>,
        <>Turn on Microsoft Teams, enter the values, and save.</>,
        <>
          Optional: to let agents read thread history (<CodeChip>chat-read-thread</CodeChip>), grant
          the app the Microsoft Graph <CodeChip>Chat.Read.*</CodeChip> permission.
        </>,
      ];
  }
}

interface ChatSdkSetupProps {
  adapter: ChatSdkAdapterName;
  docsUrl: string | undefined;
  /** Open by default once the adapter is turned on; collapsed while it is off. */
  defaultOpen: boolean;
  /** Discord only: the invite link for the entered application id. */
  inviteUrl?: string;
  /** This swarm's webhook URL for the adapter, included in the copied brief. */
  webhookUrl?: string;
}

const COPY_TOOLTIP = "Send this to Exty or your agent with computer use to set it up for you.";

function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (!isValidElement<{ children?: ReactNode; href?: unknown }>(node)) return "";
  const text = nodeText(node.props.children);
  // "label (https://...)" so the link survives the copy.
  return typeof node.props.href === "string" ? `${text} (${node.props.href})` : text;
}

/**
 * Plain text of one setup step: text, chips and bold labels as written, links
 * spelled out as "label (href)". Reads the React nodes, not the DOM, so it
 * works while the list is collapsed and unmounted.
 */
export function stepText(node: ReactNode): string {
  return nodeText(node).replace(/\s+/g, " ").trim();
}

/**
 * The steps as plain text for an agent: the same step nodes the list renders
 * (one source for what a human and an agent read), plus the values the agent
 * must bring back to this card.
 */
export function agentBrief(
  adapter: ChatSdkAdapterName,
  stepNodes: ReactNode[],
  webhookUrl: string | undefined,
  docsUrl: string | undefined,
): string {
  const def = CHAT_SDK_ADAPTER_DEFS.find((candidate) => candidate.name === adapter);
  const steps = stepNodes.map((step, index) => `${index + 1}. ${stepText(step)}`);
  const fields = (def?.fields ?? [])
    .map((field) => `- ${field.label} (${field.key})${field.required ? ", required" : ""}`)
    .join("\n");
  return [
    `Set up the ${def?.label ?? adapter} adapter of the Agent Swarm Chat SDK channel.`,
    "Follow these steps on the platform, then enter the values in the Agent Swarm dashboard under Settings > Integrations > Chat SDK, turn on the adapter and save.",
    "",
    ...steps,
    "",
    ...(webhookUrl
      ? [`Webhook URL of this swarm (where the platform needs one): ${webhookUrl}`, ""]
      : []),
    "Values the dashboard asks for:",
    fields,
    ...(docsUrl ? ["", `Docs: ${docsUrl}#${DOCS_ANCHOR[adapter]}`] : []),
  ].join("\n");
}

export function ChatSdkSetup({
  adapter,
  docsUrl,
  defaultOpen,
  inviteUrl,
  webhookUrl,
}: ChatSdkSetupProps) {
  const { copied, copy } = useCopyToClipboard();
  const [open, setOpen] = useState(defaultOpen);
  const stepNodes = steps(adapter, { docsUrl, inviteUrl });
  // The same header as CollapsibleSection (plain variant), with the copy
  // button beside the toggle: a button cannot sit inside the toggle button.
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <h3>
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
            className="group flex items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-snappy motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Setup
            </span>
          </button>
        </h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={() => void copy(agentBrief(adapter, stepNodes, webhookUrl, docsUrl))}
              aria-label={copied ? "Copied" : "Copy the setup steps for an agent"}
            >
              {copied ? <Check className="text-status-success-strong" /> : <Copy />}
              {copied ? "Copied" : "Copy for your agent"}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{COPY_TOOLTIP}</TooltipContent>
        </Tooltip>
      </div>
      <AnimatedReveal open={open}>
        <div className="space-y-2 pt-1">
          <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-muted-foreground marker:text-muted-foreground">
            {stepNodes.map((step, index) => (
              // The step list is static per adapter, so the index is a stable key.
              <li key={index} className="pl-1">
                {step}
              </li>
            ))}
          </ol>
          {docsUrl && (
            <p className="text-xs text-muted-foreground">
              Full guide:{" "}
              <ExternalLink href={`${docsUrl}#${DOCS_ANCHOR[adapter]}`}>Chat SDK docs</ExternalLink>
              .
            </p>
          )}
        </div>
      </AnimatedReveal>
    </div>
  );
}
