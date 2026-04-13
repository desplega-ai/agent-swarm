import { ArrowLeft, CheckCircle2, Clock, XCircle } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApprovalRequest, useRespondToApprovalRequest } from "@/api/hooks/use-approval-requests";
import type { ApprovalQuestion } from "@/api/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatSmartTime } from "@/lib/utils";

function QuestionField({
  question,
  value,
  onChange,
  disabled,
}: {
  question: ApprovalQuestion;
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
}) {
  switch (question.type) {
    case "approval":
      return (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={(value as { approved?: boolean })?.approved === true ? "default" : "outline"}
            className={
              (value as { approved?: boolean })?.approved === true
                ? "bg-emerald-600 hover:bg-emerald-700"
                : ""
            }
            onClick={() => onChange({ approved: true })}
            disabled={disabled}
          >
            <CheckCircle2 className="h-4 w-4 mr-1" />
            Approve
          </Button>
          <Button
            size="sm"
            variant={
              (value as { approved?: boolean })?.approved === false ? "destructive" : "outline"
            }
            onClick={() => onChange({ approved: false })}
            disabled={disabled}
          >
            <XCircle className="h-4 w-4 mr-1" />
            Reject
          </Button>
        </div>
      );

    case "text":
      return question.multiline ? (
        <Textarea
          placeholder={question.placeholder || "Enter your response..."}
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={3}
        />
      ) : (
        <Input
          placeholder={question.placeholder || "Enter your response..."}
          value={(value as string) || ""}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      );

    case "boolean":
      return (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={value === true ? "default" : "outline"}
            onClick={() => onChange(true)}
            disabled={disabled}
          >
            Yes
          </Button>
          <Button
            size="sm"
            variant={value === false ? "default" : "outline"}
            onClick={() => onChange(false)}
            disabled={disabled}
          >
            No
          </Button>
        </div>
      );

    case "single-select":
      return (
        <div className="flex flex-wrap gap-2">
          {question.options?.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={value === opt.value ? "default" : "outline"}
              onClick={() => onChange(opt.value)}
              disabled={disabled}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      );

    case "multi-select": {
      const selected = (value as string[]) || [];
      return (
        <div className="flex flex-wrap gap-2">
          {question.options?.map((opt) => {
            const isSelected = selected.includes(opt.value);
            return (
              <Button
                key={opt.value}
                size="sm"
                variant={isSelected ? "default" : "outline"}
                onClick={() => {
                  onChange(
                    isSelected ? selected.filter((v) => v !== opt.value) : [...selected, opt.value],
                  );
                }}
                disabled={disabled}
              >
                {opt.label}
              </Button>
            );
          })}
        </div>
      );
    }

    default:
      return <span className="text-sm text-muted-foreground">Unsupported question type</span>;
  }
}

export default function ApprovalRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: request, isLoading } = useApprovalRequest(id || "");
  const respondMutation = useRespondToApprovalRequest();
  const [responses, setResponses] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!request) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center text-muted-foreground">
        Approval request not found
      </div>
    );
  }

  const isPending = request.status === "pending";

  const handleSubmit = async () => {
    setError(null);
    try {
      await respondMutation.mutateAsync({ id: request.id, responses });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit response");
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link
          to="/approval-requests"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-xl font-semibold">{request.title}</h1>
        <StatusBadge status={request.status} />
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>Created {formatSmartTime(request.createdAt)}</span>
        {request.resolvedAt && <span>Resolved {formatSmartTime(request.resolvedAt)}</span>}
        {request.resolvedBy && <span>by {request.resolvedBy}</span>}
        {request.timeoutSeconds && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {request.timeoutSeconds}s timeout
          </span>
        )}
        {request.workflowRunId && (
          <Link
            to={`/workflow-runs/${request.workflowRunId}`}
            className="text-primary hover:underline"
          >
            View Workflow Run
          </Link>
        )}
        {request.sourceTaskId && (
          <Link to={`/tasks/${request.sourceTaskId}`} className="text-primary hover:underline">
            View Task
          </Link>
        )}
      </div>

      <Separator />

      <div className="space-y-4 max-w-2xl">
        {request.questions.map((question, idx) => (
          <Card key={question.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="text-muted-foreground">{idx + 1}.</span>
                {question.label}
                {question.required && <span className="text-red-400 text-xs">*</span>}
                <Badge
                  variant="outline"
                  className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ml-auto"
                >
                  {question.type}
                </Badge>
              </CardTitle>
              {question.description && (
                <p className="text-xs text-muted-foreground">{question.description}</p>
              )}
            </CardHeader>
            <CardContent>
              {isPending ? (
                <QuestionField
                  question={question}
                  value={responses[question.id]}
                  onChange={(val) => setResponses((prev) => ({ ...prev, [question.id]: val }))}
                  disabled={respondMutation.isPending}
                />
              ) : (
                <div className="text-sm">
                  <span className="text-muted-foreground">Response: </span>
                  <span className="font-mono">
                    {request.responses?.[question.id] != null
                      ? JSON.stringify(request.responses[question.id])
                      : "—"}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {isPending && (
        <div className="max-w-2xl space-y-2">
          {error && <p className="text-sm text-red-400">{error}</p>}
          <Button onClick={handleSubmit} disabled={respondMutation.isPending}>
            {respondMutation.isPending ? "Submitting..." : "Submit Response"}
          </Button>
        </div>
      )}
    </div>
  );
}
