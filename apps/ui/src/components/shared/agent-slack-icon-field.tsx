import { useState } from "react";
import { useUpdateAgentProfile } from "@/api/hooks/use-agents";
import { useSlackAppIcon } from "@/api/hooks/use-integrations-meta";
import type { Agent, AgentSlackIcon } from "@/api/types";
import { StatusIcon, type StatusTone } from "@/components/shared/status-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type AutosavePhase, useAutosave } from "@/hooks/use-autosave";
import {
  defaultSlackEmoji,
  formatSlackIcon,
  parseSlackIconInput,
  type SlackIconInput,
  slackEmojiGlyph,
} from "@/lib/slack-icon";

const PHASE_TONE: Record<AutosavePhase, StatusTone> = {
  idle: "none",
  pending: "dirty",
  saving: "busy",
  saved: "saved",
  error: "error",
};

const PHASE_LABEL: Partial<Record<AutosavePhase, string>> = {
  pending: "Saves when you stop typing",
  saving: "Saving…",
  saved: "Saved",
};

/** What Slack will show for `icon`; the caller resolves null to the agent's default emoji. */
function SlackIconPreview({
  icon,
  appIconUrl,
  onBrokenImage,
}: {
  icon: AgentSlackIcon;
  appIconUrl: string | null | undefined;
  onBrokenImage: () => void;
}) {
  // An app avatar that fails to load falls back to the badge.
  const [failedAppSrc, setFailedAppSrc] = useState<string | null>(null);
  if (icon.type === "emoji") {
    const glyph = slackEmojiGlyph(icon.emoji);
    if (glyph) {
      return (
        <span role="img" aria-label={icon.emoji} className="text-lg leading-none">
          {glyph}
        </span>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {icon.emoji}
          </span>
        </TooltipTrigger>
        <TooltipContent>Custom emoji, shown in Slack</TooltipContent>
      </Tooltip>
    );
  }
  const src = icon.type === "url" ? icon.url : appIconUrl;
  if (!src || (icon.type === "app" && src === failedAppSrc)) {
    return (
      <Badge variant="outline" size="tag">
        Slack app
      </Badge>
    );
  }
  return (
    <img
      src={src}
      alt={icon.type === "app" ? "Slack app icon" : ""}
      referrerPolicy="no-referrer"
      onError={icon.type === "url" ? onBrokenImage : () => setFailedAppSrc(src)}
      className="size-5 rounded-sm object-cover"
    />
  );
}

export function AgentSlackIconField({ agent }: { agent: Agent }) {
  const updateProfile = useUpdateAgentProfile();
  const storedIcon = agent.slackIcon ?? null;
  // Typed text (null shows the stored value), and a click on "Use Slack app icon".
  const [draft, setDraft] = useState<string | null>(null);
  const [pickedApp, setPickedApp] = useState(false);
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const usingApp = pickedApp || (draft === null && storedIcon?.type === "app");
  const text = usingApp ? "" : (draft ?? formatSlackIcon(storedIcon));
  const parsed: SlackIconInput = usingApp
    ? { ok: true, icon: { type: "app" } }
    : parseSlackIconInput(text);
  // The autosave value is the icon as JSON, so every choice shares one save chain.
  const value = parsed.ok ? JSON.stringify(parsed.icon) : null;

  const autosave = useAutosave({
    value: value ?? "",
    dirty: (draft !== null || pickedApp) && value !== null && value !== JSON.stringify(storedIcon),
    ready: parsed.ok,
    save: async (json) => {
      await updateProfile.mutateAsync({ id: agent.id, profile: { slackIcon: JSON.parse(json) } });
    },
  });

  function edit(next: string) {
    setPickedApp(false);
    setDraft(next);
  }

  function reset() {
    edit("");
    autosave.commit();
  }

  function pickAppIcon() {
    setPickedApp(true);
    autosave.commit();
  }

  const previewUrl = parsed.ok && parsed.icon?.type === "url" ? parsed.icon.url : null;
  const appIcon = useSlackAppIcon(usingApp);
  const defaultEmoji = defaultSlackEmoji(agent);
  // Invalid input shows no preview; empty input previews the agent's default.
  const preview: AgentSlackIcon | null = parsed.ok
    ? (parsed.icon ?? { type: "emoji", emoji: defaultEmoji })
    : null;
  const error = !parsed.ok ? parsed.error : autosave.phase === "error" ? autosave.error : null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Input
            value={text}
            onChange={(event) => edit(event.target.value)}
            onBlur={() => {
              // Show what is stored: `owl` becomes `:owl:`.
              const shown = parsed.ok ? formatSlackIcon(parsed.icon) : text;
              if (!usingApp && shown !== text) setDraft(shown);
              autosave.commit();
            }}
            placeholder={usingApp ? "Slack app icon" : ":owl: or https://…/icon.png"}
            aria-label="Slack icon"
            aria-invalid={error !== null}
            autoComplete="off"
            spellCheck={false}
            className="pr-8"
          />
          <span className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center">
            <StatusIcon
              tone={parsed.ok ? PHASE_TONE[autosave.phase] : "none"}
              label={autosave.phase === "error" ? autosave.error : PHASE_LABEL[autosave.phase]}
            />
          </span>
        </div>
        <div className="flex items-center gap-2">
          {preview && !(previewUrl && brokenUrl === previewUrl) ? (
            <SlackIconPreview
              icon={preview}
              appIconUrl={appIcon.data?.imageUrl}
              onBrokenImage={() => setBrokenUrl(previewUrl)}
            />
          ) : null}
          {usingApp ? null : (
            <Button variant="ghost" size="sm" onClick={pickAppIcon}>
              Use Slack app icon
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={reset} disabled={value === "null"}>
            Reset to default
          </Button>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-status-error-strong">{error}</p>
      ) : previewUrl && brokenUrl === previewUrl ? (
        <p className="text-xs text-muted-foreground">Can't load image.</p>
      ) : usingApp ? (
        <p className="text-xs text-muted-foreground">
          Uses the Slack app's own icon. Type an emoji or URL to replace it.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Used for this agent's Slack messages. Leave empty for the default:{" "}
          {slackEmojiGlyph(defaultEmoji)} {defaultEmoji}.
        </p>
      )}
    </div>
  );
}
