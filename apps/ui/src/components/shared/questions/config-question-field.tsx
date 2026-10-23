import { ExternalLink, KeyRound } from "lucide-react";
import { useEffect } from "react";
import type { ApprovalConfigAnswer, ApprovalConfigState, ApprovalQuestion } from "@/api/types";
import { Input } from "@/components/ui/input";
import { formatLocalDateTime } from "@/lib/approval-format";
import { findCatalogField } from "@/lib/integrations-catalog";
import { cn } from "@/lib/utils";
import { DecisionSegments, OptionChoices, SegmentLabel } from "./question-field";

/**
 * The catalog label stands in for a config question whose label is just its
 * key (the server default). Every other question is returned unchanged.
 */
export function withCatalogLabel(question: ApprovalQuestion): ApprovalQuestion {
  if (question.type !== "config" || !question.config) return question;
  if (question.label !== question.config.key) return question;
  const label = findCatalogField(question.config.key)?.field.label;
  return label ? { ...question, label } : question;
}

function asAnswer(value: unknown): ApprovalConfigAnswer | null {
  if (typeof value !== "object" || value === null) return null;
  const action = (value as { action?: unknown }).action;
  if (action === "set" || action === "keep" || action === "skip") {
    return value as ApprovalConfigAnswer;
  }
  return null;
}

/**
 * One swarm config key: where it goes, whether it is already set, and an
 * input for a new value. A secret's current value is never fetched or shown.
 */
export function ConfigQuestionField({
  question,
  state,
  value,
  onChange,
  disabled,
  showKeys,
  onSubmitShortcut,
}: {
  question: ApprovalQuestion;
  state?: ApprovalConfigState;
  value: unknown;
  onChange: (value: ApprovalConfigAnswer) => void;
  disabled: boolean;
  showKeys: boolean;
  onSubmitShortcut?: () => void;
}) {
  const settings = question.config;
  const answer = asAnswer(value);
  const isSecret = settings?.isSecret !== false || state?.isSecret === true;
  const exists = state?.exists === true;
  const optional = question.required === false;
  const options = !isSecret ? settings?.options : undefined;
  const defaultValue = !isSecret ? settings?.defaultValue : undefined;

  // A new or replaced plain value starts from the question's default.
  const wantsInput = exists ? answer?.action === "set" : answer?.action !== "skip";
  useEffect(() => {
    if (!exists && answer === null && defaultValue !== undefined) {
      onChange({ action: "set", value: defaultValue });
    }
  }, [exists, answer, defaultValue, onChange]);

  if (!settings) {
    return <span className="text-sm text-muted-foreground">Missing config settings</span>;
  }

  const catalog = findCatalogField(settings.key);
  const helpUrl = settings.helpUrl ?? catalog?.integration.docsUrl;
  const where = `${settings.scope}${settings.scopeId ? `:${settings.scopeId}` : ""}`;
  const status = !exists
    ? "Not set"
    : isSecret
      ? state?.updatedAt
        ? `Set, updated ${formatLocalDateTime(state.updatedAt)}`
        : "Set"
      : `Current: ${state?.value ?? ""}`;

  const mode = answer?.action === "set" ? "replace" : (answer?.action ?? null);
  const segments: { value: "keep" | "replace" | "skip"; text: string }[] = exists
    ? [
        { value: "keep", text: "Keep" },
        { value: "replace", text: "Replace" },
      ]
    : optional
      ? [{ value: "replace", text: "Set" }]
      : [];
  if (optional) segments.push({ value: "skip", text: "Skip" });

  const currentText = answer?.action === "set" ? answer.value : "";
  const setValue = (next: string) => onChange({ action: "set", value: next });

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <KeyRound className="size-3.5 shrink-0" aria-hidden />
        <code className="font-mono text-foreground">{settings.key}</code>
        <span aria-hidden>·</span>
        <span className="font-mono">{where}</span>
        <span aria-hidden>·</span>
        <span>{isSecret ? "secret, stored encrypted" : "plain value"}</span>
      </div>
      <p
        className={cn("text-sm", exists ? "text-foreground" : "text-muted-foreground")}
        data-testid="config-status"
      >
        {status}
      </p>
      {catalog?.field.helpText || helpUrl ? (
        <p className="text-xs text-muted-foreground">
          {catalog?.field.helpText}
          {catalog?.field.helpText && helpUrl ? " " : null}
          {helpUrl ? (
            <a
              href={helpUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              {catalog ? `${catalog.integration.name} docs` : "Help"}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </p>
      ) : null}
      {segments.length > 0 ? (
        <DecisionSegments
          label={`${question.label}: what to do with ${settings.key}`}
          value={mode}
          onValueChange={(next) => {
            if (next === "keep") onChange({ action: "keep" });
            else if (next === "skip") onChange({ action: "skip" });
            else setValue(defaultValue ?? "");
          }}
          keys={[]}
          tone={null}
          disabled={disabled}
          options={segments.map((segment) => ({
            value: segment.value,
            label: (
              <SegmentLabel text={segment.text} checked={mode === segment.value} showKeys={false} />
            ),
          }))}
        />
      ) : null}
      {wantsInput ? (
        options && options.length > 0 ? (
          <OptionChoices
            question={question}
            options={options}
            selected={currentText ? [currentText] : []}
            multi={false}
            onToggle={setValue}
            cursor={-1}
            showKeys={showKeys}
            disabled={disabled}
          />
        ) : (
          <Input
            type={isSecret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            aria-label={`${question.label} (${settings.key})`}
            aria-keyshortcuts={onSubmitShortcut ? "Control+Enter Meta+Enter" : undefined}
            placeholder={
              catalog?.field.placeholder ?? (isSecret ? "Paste the secret value" : "Value")
            }
            value={currentText}
            disabled={disabled}
            className="h-11 font-mono text-base sm:h-9 sm:text-sm"
            onChange={(event) => setValue(event.target.value)}
          />
        )
      ) : null}
    </div>
  );
}
