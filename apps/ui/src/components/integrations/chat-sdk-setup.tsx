import type { ReactNode } from "react";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import type { ChatSdkAdapterName } from "@/lib/chat-sdk-fields";
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

function steps(adapter: ChatSdkAdapterName, docsUrl: string | undefined): ReactNode[] {
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
          Invite the bot with the <CodeChip>bot</CodeChip> scope and these permissions: Send
          Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message
          History, Add Reactions, Attach Files.
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
  /** Collapsed by default when the adapter already runs healthy. */
  defaultOpen: boolean;
}

export function ChatSdkSetup({ adapter, docsUrl, defaultOpen }: ChatSdkSetupProps) {
  return (
    <CollapsibleSection title="Setup" heading="h3" defaultOpen={defaultOpen}>
      <div className="space-y-2 pt-1">
        <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-5 text-muted-foreground marker:text-muted-foreground">
          {steps(adapter, docsUrl).map((step, index) => (
            // The step list is static per adapter, so the index is a stable key.
            <li key={index} className="pl-1">
              {step}
            </li>
          ))}
        </ol>
        {docsUrl && (
          <p className="text-xs text-muted-foreground">
            Full guide:{" "}
            <ExternalLink href={`${docsUrl}#${DOCS_ANCHOR[adapter]}`}>Chat SDK docs</ExternalLink>.
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}
