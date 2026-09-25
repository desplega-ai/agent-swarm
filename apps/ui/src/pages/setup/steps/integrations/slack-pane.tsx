import { useQuery } from "@tanstack/react-query";
import { Bot, Check, Copy } from "lucide-react";
import { api } from "@/api/client";
import { useStatus } from "@/api/hooks/use-status";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { swarmDisplayName } from "../../components/swarm-name";
import { SLACK_TOKEN_FIELDS } from "./catalog";
import { ConnectedGate, ExternalTextLink } from "./pane-parts";
import { FieldGrid } from "./setup-field";
import { type PaneProps, useConfigForm } from "./use-config-form";

const SLACK_APPS_URL = "https://api.slack.com/apps?new_app=1";

/**
 * Prompt for an agent with computer use (Codex, Claude Code) that creates the
 * Slack app and reports the two tokens back. It embeds the manifest. It never
 * contains the swarm API key or any other secret.
 */
function buildSlackSetupPrompt(manifestJson: string): string {
  return `You have computer use. Please create a Slack app for my Agent Swarm and give me its two tokens. Use the browser. Do not ask me for a password or a secret, and do not paste the tokens anywhere except your final answer to me.

1. Open https://api.slack.com/apps and sign in if Slack asks. Click "Create New App", choose "From a manifest", pick my workspace, then paste this manifest (JSON) and create the app:

\`\`\`json
${manifestJson}
\`\`\`

2. Socket Mode: open "Socket Mode" in the app settings and make sure it is on. Then open "Basic Information", find "App-Level Tokens", and generate a token named "agent-swarm" with the scope \`connections:write\`. Copy the token. It starts with \`xapp-\`.

3. Install: open "Install App" and click "Install to Workspace". Approve the permissions. Copy the "Bot User OAuth Token". It starts with \`xoxb-\`.

4. Report back only these two lines, so I can paste them into the Agent Swarm setup page:

SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

If a step fails, stop and tell me what you see on the screen.`;
}

export function SlackPane({ configs, presence, connected }: PaneProps) {
  const form = useConfigForm(configs, presence);
  return (
    <ConnectedGate
      connected={connected}
      summary="Connected. Mention the bot in a channel to send a task."
    >
      <SlackAppActions />
      <FieldGrid specs={SLACK_TOKEN_FIELDS} form={form} />
    </ConnectedGate>
  );
}

/** Copy the manifest (pre-filled with the swarm name) or a setup prompt for an agent. */
function SlackAppActions() {
  const statusQ = useStatus();
  // Unset `SWARM_ORG_NAME` reads as "Swarm" on /status. Use the step 2 default instead.
  const name = swarmDisplayName(statusQ.data?.identity?.name);
  const manifestQ = useQuery({
    queryKey: ["slack-manifest", name],
    queryFn: () => api.fetchSlackManifest(name),
    enabled: !statusQ.isPending,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  const { copiedKey, copy } = useCopyToClipboard<"manifest" | "prompt">();
  const manifest = manifestQ.data ? JSON.stringify(manifestQ.data, null, 2) : null;
  // An older API has no manifest route: only the link stays.
  const unavailable = manifestQ.isError;

  return (
    // The link sits on its own line, so nothing moves when a button shows its check.
    <div className="flex flex-col items-start gap-2">
      {unavailable ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {/* Only the icon swaps on copy: the labels keep their width. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!manifest}
            onClick={() => manifest && void copy(manifest, "manifest")}
          >
            {copiedKey === "manifest" ? <Check /> : <Copy />}
            Copy manifest
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!manifest}
            onClick={() => manifest && void copy(buildSlackSetupPrompt(manifest), "prompt")}
          >
            {copiedKey === "prompt" ? <Check /> : <Bot />}
            Copy setup prompt
          </Button>
          <InfoTip content='Pick "From a manifest" and paste the manifest. Or give the setup prompt to Codex or Claude Code with computer use: it creates the app and reports both tokens.' />
          <span aria-live="polite" className="sr-only">
            {copiedKey === "manifest"
              ? "Manifest copied"
              : copiedKey === "prompt"
                ? "Setup prompt copied"
                : ""}
          </span>
        </div>
      )}
      <span className="text-sm">
        <ExternalTextLink href={SLACK_APPS_URL}>
          Create the app at api.slack.com/apps
        </ExternalTextLink>
      </span>
    </div>
  );
}
