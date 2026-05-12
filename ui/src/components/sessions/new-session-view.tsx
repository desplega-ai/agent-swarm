/**
 * Sessions surface — empty `/sessions` view: header strip + suggestion chips +
 * composer dock. Submitting creates a root task and navigates to the new
 * session detail page.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { useTaskTemplates } from "@/api/hooks/use-task-templates";
import { Badge } from "@/components/ui/badge";
import { useCurrentUser } from "@/contexts/current-user-context";
import { ComposerDock } from "./composer-dock";

const SUGGESTIONS = [
  "Investigate a flaky test in the auth suite",
  "Spawn a research crew on a new library",
  "Review the latest open PRs",
  "Draft a tech-spec for a feature idea",
];

export function NewSessionView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { userId } = useCurrentUser();
  const [draft, setDraft] = useState("");
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
  }, [seedText, searchParams, setSearchParams]);

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
  }, [prefillTemplateId, templatesQ.data, searchParams, setSearchParams]);

  const create = useMutation({
    mutationFn: (input: { task: string; requestedByUserId?: string }) =>
      api.createTask({
        task: input.task,
        requestedByUserId: input.requestedByUserId,
        source: "ui",
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      navigate(`/sessions/${created.id}`);
    },
  });

  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || create.isPending) return;
    create.mutate({ task: trimmed, requestedByUserId: userId ?? undefined });
  };

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
          <div className="flex flex-wrap items-center justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setDraft(s)}
                disabled={!userId || create.isPending}
                className="text-xs"
              >
                <Badge
                  variant="outline"
                  className="cursor-pointer hover:bg-muted/60 hover:border-primary/40 transition-colors px-3 py-1 font-normal text-xs normal-case"
                >
                  {s}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      </div>

      <ComposerDock
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        isPending={create.isPending}
        isError={create.isError}
        errorMessage={
          create.error instanceof Error ? create.error.message : "Failed to create session"
        }
        placeholder={
          userId ? "What's the goal?" : "Pick an identity in the sidebar before starting a session."
        }
        disabled={!userId}
        sendLabel="Start session"
        autoFocus
      />
    </>
  );
}
