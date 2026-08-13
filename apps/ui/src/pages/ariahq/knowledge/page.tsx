import { AlertTriangle, ArrowUp, BookOpenCheck, LoaderCircle, ShieldAlert } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useAskAria } from "@/api/hooks/use-ariahq";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Textarea } from "@/components/ui/textarea";

export default function AriaKnowledgePage() {
  const [question, setQuestion] = useState("");
  const ask = useAskAria();
  function submit(event: FormEvent) {
    event.preventDefault();
    if (question.trim()) ask.mutate(question.trim());
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6">
      <PageHeader
        title="Ask Aria"
        description="Answers are assembled from authorized organizational evidence. Sources, freshness, and conflicts stay visible."
      />
      <Card className="border-primary/20 shadow-sm">
        <CardContent className="pt-6">
          <form onSubmit={submit} className="space-y-3">
            <Textarea
              aria-label="Ask Aria a question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="What did we commit to for the Rentvine renewal, and what evidence supports it?"
              className="min-h-28 resize-none border-0 bg-muted/40 text-base shadow-none focus-visible:ring-1"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Aria will abstain when authorized evidence is insufficient.
              </p>
              <Button type="submit" disabled={ask.isPending || !question.trim()}>
                {ask.isPending ? <LoaderCircle className="animate-spin" /> : <ArrowUp />} Ask
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {ask.data ? (
        <div className="space-y-4">
          {ask.data.bundle.hasConflict ? (
            <Card className="border-status-warning/40 bg-status-warning/[0.04] shadow-none">
              <CardContent className="flex gap-3 pt-6">
                <AlertTriangle className="size-5 shrink-0 text-status-warning" />
                <div>
                  <p className="font-medium">Conflicting evidence found</p>
                  <p className="text-sm text-muted-foreground">
                    Aria will surface the disagreement and will not silently choose a version.
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : null}
          <Card className="shadow-none">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <BookOpenCheck className="size-5 text-primary" /> Evidence bundle
                </CardTitle>
                <Badge variant="outline">{ask.data.bundle.evidence.length} sources</Badge>
              </div>
              <CardDescription>
                {ask.data.status === "dispatched"
                  ? `Answer task ${ask.data.taskId?.slice(0, 8)} is running from this immutable evidence bundle.`
                  : ask.data.message}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {ask.data.bundle.evidence.map((item, index) => (
                <div key={item.recordId} className="rounded-lg border border-border-subtle p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {index + 1}
                    </span>
                    <Badge variant="outline" size="tag">
                      {item.kind.replaceAll("_", " ")}
                    </Badge>
                    <Badge
                      variant={
                        item.verificationStatus === "conflicted" ? "destructive" : "secondary"
                      }
                      size="tag"
                    >
                      {item.verificationStatus}
                    </Badge>
                  </div>
                  <p className="text-sm">{item.content}</p>
                  <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
                    {item.citation}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card className="border-dashed shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <ShieldAlert className="size-7 text-muted-foreground" />
            <div>
              <p className="font-medium">Definitive means traceable</p>
              <p className="mt-1 max-w-lg text-sm text-muted-foreground">
                Aria separates source evidence, verified canonical facts, and time-limited derived
                insight. Client contexts can never retrieve internal evidence.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
