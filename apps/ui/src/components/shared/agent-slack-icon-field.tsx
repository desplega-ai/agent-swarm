import { useState } from "react";
import { useUpdateAgentProfile } from "@/api/hooks/use-agents";
import type { Agent } from "@/api/types";
import { StatusIcon, type StatusTone } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AutosavePhase, useAutosave } from "@/hooks/use-autosave";
import { formatSlackIcon, parseSlackIconInput } from "@/lib/slack-icon";

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

/**
 * The agent's Slack icon: an emoji code or an https image URL. Saves itself
 * through `PUT /api/agents/{id}/profile`; blank or "Reset to default" stores
 * `null`, which brings back the default emoji.
 */
export function AgentSlackIconField({ agent }: { agent: Agent }) {
  const updateProfile = useUpdateAgentProfile();
  const stored = formatSlackIcon(agent.slackIcon);
  const [draft, setDraft] = useState<string | null>(null);
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const text = draft ?? stored;
  const parsed = parseSlackIconInput(text);
  const shown = parsed.ok ? formatSlackIcon(parsed.icon) : null;

  const autosave = useAutosave({
    value: shown ?? "",
    dirty: draft !== null && shown !== null && shown !== stored,
    ready: parsed.ok,
    save: async (value) => {
      const result = parseSlackIconInput(value);
      if (!result.ok) throw new Error(result.error);
      await updateProfile.mutateAsync({ id: agent.id, profile: { slackIcon: result.icon } });
    },
  });

  function reset() {
    setDraft("");
    autosave.commit();
  }

  const previewUrl = parsed.ok && parsed.icon?.type === "url" ? parsed.icon.url : null;
  const error = !parsed.ok ? parsed.error : autosave.phase === "error" ? autosave.error : null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Input
            value={text}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              // Show what is stored: `owl` becomes `:owl:`.
              if (shown !== null && shown !== text) setDraft(shown);
              autosave.commit();
            }}
            placeholder=":owl: or https://…/icon.png"
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
        {previewUrl && brokenUrl !== previewUrl ? (
          <img
            src={previewUrl}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setBrokenUrl(previewUrl)}
            className="size-5 rounded-sm object-cover"
          />
        ) : null}
        <Button variant="ghost" size="sm" onClick={reset} disabled={!stored && !text.trim()}>
          Reset to default
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-status-error-strong">{error}</p>
      ) : previewUrl && brokenUrl === previewUrl ? (
        <p className="text-xs text-muted-foreground">Can't load image.</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Used for this agent's Slack messages. Leave empty for the default (:crown: for the lead).
        </p>
      )}
    </div>
  );
}
