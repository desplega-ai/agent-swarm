/**
 * Sessions surface — empty `/sessions` view: header strip + suggestion chips +
 * composer dock. Submitting creates a root task and navigates to the new
 * session detail page.
 */

import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTaskTemplates } from "@/api/hooks/use-task-templates";
import { SuggestionChips } from "@/components/shared/suggestion-chips";
import { ComposerDock } from "./composer-dock";
import { useStartSession } from "./use-start-session";

export const SUGGESTIONS = [
  "Investigate a flaky test in the auth suite",
  "Spawn a research crew on a new library",
  "Review the latest open PRs",
  "Draft a tech-spec for a feature idea",
];

export function NewSessionView() {
  const navigate = useNavigate();
  const { userId, setDraft, isPending, composerProps } = useStartSession({
    onStarted: (created) => void navigate(`/sessions/${created.id}`),
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const prefillTemplateId = searchParams.get("prefill");
  const seedText = searchParams.get("seed");

  // ?seed=<text> — home page's "what do you have in mind?" shortcut forwards
  // typed text directly. Strip the param so refreshing doesn't re-seed.
  useEffect(() => {
    if (!seedText) return;
    setDraft(seedText);
    const next = new URLSearchParams(searchParams);
    next.delete("seed");
    setSearchParams(next, { replace: true });
  }, [seedText, searchParams, setSearchParams, setDraft]);

  // ?prefill=<templateId> — dashboard "To start" bucket. Look up the template
  // and seed the composer with its prompt.
  const templatesQ = useTaskTemplates({ kind: "task" });
  useEffect(() => {
    if (!prefillTemplateId || !templatesQ.data) return;
    const tmpl = templatesQ.data.find((t) => t.id === prefillTemplateId);
    if (!tmpl) return;
    setDraft(tmpl.prompt);
    const next = new URLSearchParams(searchParams);
    next.delete("prefill");
    setSearchParams(next, { replace: true });
  }, [prefillTemplateId, templatesQ.data, searchParams, setSearchParams, setDraft]);

  return (
    <>
      {/* Empty hero — centered, generous, suggestion chips. */}
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center px-6">
        <div className="flex flex-col items-center gap-6 max-w-xl text-center py-10">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-foreground">
            What would you like the swarm to do?
          </h1>
          <p className="text-sm text-muted-foreground max-w-md">
            Describe a goal. The lead agent picks it up, spawns the right crew, and chains the
            follow-ups under one session.
          </p>
          <SuggestionChips
            suggestions={SUGGESTIONS}
            onPick={setDraft}
            disabled={!userId || isPending}
          />
        </div>
      </div>

      <ComposerDock
        {...composerProps}
        placeholder={
          userId ? "What's the goal?" : "Pick an identity in the sidebar before starting a session."
        }
        sendLabel="Start session"
        autoFocus
      />
    </>
  );
}
