import { CheckCircle2, LoaderCircle, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  useAriaEngineCatalog,
  useCreateAriaEngineDraft,
  usePublishAriaEngineDraft,
  useReconcileAriaEngineDraft,
} from "@/api/hooks/use-ariahq";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Textarea } from "@/components/ui/textarea";

export default function AriaEngineStudioPage() {
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const catalog = useAriaEngineCatalog();
  const createDraft = useCreateAriaEngineDraft();
  const reconcile = useReconcileAriaEngineDraft();
  const publish = usePublishAriaEngineDraft();

  function submit(event: FormEvent) {
    event.preventDefault();
    createDraft.mutate(
      { name, brief },
      {
        onSuccess: () => {
          setName("");
          setBrief("");
        },
      },
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Engine Studio"
        description="Describe an operational flow in plain language. Aria drafts a strict contract; a human resolves authority before it can become a workflow."
      />
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="size-4" /> New engine
            </CardTitle>
            <CardDescription>
              Start with the objective, evidence, decisions, actions, and definition of done.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2">
                <label htmlFor="engine-name" className="text-sm font-medium">
                  Engine name
                </label>
                <Input
                  id="engine-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Renewal Engine"
                  required
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="engine-brief" className="text-sm font-medium">
                  What should it accomplish?
                </label>
                <Textarea
                  id="engine-brief"
                  value={brief}
                  onChange={(event) => setBrief(event.target.value)}
                  placeholder="Monitor renewal risk using CRM and call evidence. Require the account owner before any CRM write..."
                  className="min-h-40"
                  required
                />
              </div>
              <div className="rounded-lg border border-border-subtle bg-muted/40 p-3 text-xs text-muted-foreground">
                <ShieldCheck className="mb-2 size-4 text-primary" />
                Natural language can propose a contract. It cannot grant data access, approval
                rights, or external-write authority.
              </div>
              <Button type="submit" className="w-full" disabled={createDraft.isPending}>
                {createDraft.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />} Draft
                with Aria
              </Button>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          {(catalog.data?.drafts ?? []).map((draft) => (
            <Card key={draft.id} className="shadow-none">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle>{draft.name}</CardTitle>
                    <CardDescription className="mt-1 line-clamp-2">{draft.brief}</CardDescription>
                  </div>
                  <Badge variant={draft.status === "failed" ? "destructive" : "outline"}>
                    {draft.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {draft.proposedContract ? (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">Stages</div>
                      <div className="mt-1 font-semibold">
                        {draft.proposedContract.stages.length}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">Human gates</div>
                      <div className="mt-1 font-semibold">
                        {
                          draft.proposedContract.stages.filter((stage) => stage.kind === "approval")
                            .length
                        }
                      </div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">Open questions</div>
                      <div className="mt-1 font-semibold">
                        {draft.proposedContract.openQuestions.length}
                      </div>
                    </div>
                  </div>
                ) : null}
                {draft.errorMessage ? (
                  <p className="text-sm text-destructive">{draft.errorMessage}</p>
                ) : null}
                <div className="flex justify-end gap-2">
                  {draft.status === "running" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => reconcile.mutate(draft.id)}
                      disabled={reconcile.isPending}
                    >
                      <RefreshCw /> Check draft
                    </Button>
                  ) : null}
                  {draft.status === "ready" ? (
                    <Button
                      size="sm"
                      onClick={() => publish.mutate(draft.id)}
                      disabled={publish.isPending || !!draft.proposedContract?.openQuestions.length}
                    >
                      <CheckCircle2 /> Publish governed engine
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
          {(catalog.data?.engines ?? []).map((engine) => (
            <Card key={engine.id} className="border-status-success/30 shadow-none">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{engine.name}</CardTitle>
                  <Badge variant="outline">v{engine.version} · published</Badge>
                </div>
                <CardDescription>{engine.contract.objective}</CardDescription>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                Backed by workflow {engine.workflowId.slice(0, 8)} · {engine.contract.stages.length}{" "}
                governed stages
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
