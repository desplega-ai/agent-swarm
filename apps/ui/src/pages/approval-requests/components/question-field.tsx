import { Check, CircleCheck, CircleX } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { ApprovalQuestion } from "@/api/types";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { WRAP } from "./answer-view";
import { KeyHint, MOD } from "./keyboard";

type Options = NonNullable<ApprovalQuestion["options"]>;

/** Segmented options fit on a phone only when they are few and short. */
export function usesSegmented(question: ApprovalQuestion): boolean {
  if (question.type === "approval" || question.type === "boolean") return true;
  if (question.type !== "single-select") return false;
  const options = question.options ?? [];
  return (
    options.length >= 2 &&
    options.length <= 3 &&
    options.every((option) => !option.description && option.label.length <= 16)
  );
}

/** The option values the number keys map to, in order. */
export function optionValues(question: ApprovalQuestion): string[] {
  if (question.type === "boolean") return ["yes", "no"];
  return (question.options ?? []).map((option) => option.value);
}

/**
 * The #1604 SegmentedControl, full width with 44px targets on phones, and a
 * tone for the pill (approve = green, reject = red) set from outside, since
 * the control itself only knows the amber pill. Each radio gets its
 * `aria-keyshortcuts` after render (the control does not forward props).
 */
function DecisionSegments<T extends string>({
  value,
  onValueChange,
  options,
  keys,
  tone,
  label,
  disabled,
}: {
  value: T | null;
  onValueChange: (value: T) => void;
  options: { value: T; label: ReactNode; tooltip?: ReactNode }[];
  keys: string[];
  tone: "success" | "error" | null;
  label: string;
  disabled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const radios = ref.current?.querySelectorAll('[role="radio"]') ?? [];
    radios.forEach((radio, index) => {
      if (keys[index]) radio.setAttribute("aria-keyshortcuts", keys[index]);
    });
  });
  return (
    <div ref={ref} className="w-full sm:w-auto">
      <SegmentedControl
        aria-label={label}
        value={value}
        onValueChange={onValueChange}
        options={options}
        disabled={disabled}
        className={cn(
          "grid h-11 w-full auto-cols-fr grid-flow-col sm:inline-flex sm:h-9 sm:w-auto",
          "[&_[role=radio]]:px-4 [&_[role=radio]]:text-sm",
          tone === "success" &&
            "[&_span.bg-primary]:bg-status-success [&_[aria-checked=true]]:text-status-success-foreground",
          tone === "error" &&
            "[&_span.bg-primary]:bg-status-error [&_[aria-checked=true]]:text-status-error-foreground",
        )}
      />
    </div>
  );
}

function SegmentLabel({
  icon,
  text,
  keyName,
  checked,
  showKeys,
}: {
  icon?: ReactNode;
  text: string;
  keyName?: string;
  checked: boolean;
  showKeys: boolean;
}) {
  return (
    <>
      {icon}
      <span className="truncate">{text}</span>
      {showKeys && keyName ? (
        <KeyHint tone={checked ? "inverted" : "default"} className="ml-1">
          {keyName}
        </KeyHint>
      ) : null}
    </>
  );
}

/** Option chips (few, short) or option rows (with descriptions), single or multi. */
function OptionChoices({
  question,
  options,
  selected,
  multi,
  onToggle,
  cursor,
  showKeys,
  disabled,
}: {
  question: ApprovalQuestion;
  options: Options;
  selected: string[];
  multi: boolean;
  onToggle: (value: string) => void;
  cursor: number;
  showKeys: boolean;
  disabled: boolean;
}) {
  const rows = options.some((option) => option.description) || options.length > 8;
  return (
    <div
      {...(multi
        ? { role: "group", "aria-label": question.label }
        : { role: "radiogroup", "aria-label": question.label })}
      className={cn(rows ? "flex flex-col gap-1.5" : "flex flex-wrap gap-2")}
    >
      {options.map((option, index) => {
        const isSelected = selected.includes(option.value);
        const keyName = index < 9 ? String(index + 1) : undefined;
        const highlighted = multi && cursor === index;
        return (
          <button
            key={option.value}
            type="button"
            {...(multi
              ? { role: "checkbox", "aria-checked": isSelected }
              : { role: "radio", "aria-checked": isSelected })}
            aria-keyshortcuts={keyName}
            disabled={disabled}
            onClick={() => onToggle(option.value)}
            className={cn(
              "group/opt relative flex items-center gap-2 border text-left text-sm transition-[background-color,border-color,color,box-shadow] duration-150 ease-snappy outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 active:scale-[0.99]",
              rows
                ? "min-h-11 w-full rounded-lg px-3 py-2 sm:min-h-10"
                : "min-h-11 rounded-full px-3.5 py-1.5 sm:min-h-8",
              isSelected
                ? "border-primary/60 bg-primary/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:bg-muted/60 hover:text-foreground",
              highlighted && "ring-2 ring-primary/40",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "flex size-4 shrink-0 items-center justify-center border transition-colors",
                multi ? "rounded-[4px]" : "rounded-full",
                isSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40",
              )}
            >
              {isSelected ? <Check className="size-3" strokeWidth={3} /> : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn(WRAP, isSelected && "font-medium")}>{option.label}</span>
              {option.description ? (
                <span className={cn("text-xs text-muted-foreground", WRAP)}>
                  {option.description}
                </span>
              ) : null}
            </span>
            {showKeys && keyName ? <KeyHint className="shrink-0">{keyName}</KeyHint> : null}
          </button>
        );
      })}
    </div>
  );
}

export function QuestionField({
  question,
  value,
  onChange,
  disabled,
  cursor,
  showKeys,
  onSubmitShortcut,
}: {
  question: ApprovalQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  /** Multi-select highlight for Space (−1: none). */
  cursor: number;
  /** Keycaps on this card (the keyboard-focused one, fine pointers only). */
  showKeys: boolean;
  onSubmitShortcut?: () => void;
}) {
  switch (question.type) {
    case "approval": {
      const approved = (value as { approved?: unknown } | undefined)?.approved;
      const current = approved === true ? "approve" : approved === false ? "reject" : null;
      return (
        <DecisionSegments
          label={question.label}
          value={current}
          onValueChange={(next) => onChange({ approved: next === "approve" })}
          keys={["A", "R"]}
          tone={current === "approve" ? "success" : current === "reject" ? "error" : null}
          disabled={disabled}
          options={[
            {
              value: "approve",
              label: (
                <SegmentLabel
                  icon={<CircleCheck />}
                  text="Approve"
                  keyName="A"
                  checked={current === "approve"}
                  showKeys={showKeys}
                />
              ),
            },
            {
              value: "reject",
              label: (
                <SegmentLabel
                  icon={<CircleX />}
                  text="Reject"
                  keyName="R"
                  checked={current === "reject"}
                  showKeys={showKeys}
                />
              ),
            },
          ]}
        />
      );
    }

    case "boolean": {
      const current = value === true ? "yes" : value === false ? "no" : null;
      return (
        <DecisionSegments
          label={question.label}
          value={current}
          onValueChange={(next) => onChange(next === "yes")}
          keys={["1", "2"]}
          tone={null}
          disabled={disabled}
          options={[
            {
              value: "yes",
              label: (
                <SegmentLabel
                  text="Yes"
                  keyName="1"
                  checked={current === "yes"}
                  showKeys={showKeys}
                />
              ),
            },
            {
              value: "no",
              label: (
                <SegmentLabel
                  text="No"
                  keyName="2"
                  checked={current === "no"}
                  showKeys={showKeys}
                />
              ),
            },
          ]}
        />
      );
    }

    case "single-select": {
      const options = question.options ?? [];
      const current = typeof value === "string" && value ? value : null;
      if (usesSegmented(question)) {
        return (
          <DecisionSegments
            label={question.label}
            value={current}
            onValueChange={(next) => onChange(next)}
            keys={options.map((_, index) => String(index + 1))}
            tone={null}
            disabled={disabled}
            options={options.map((option, index) => ({
              value: option.value,
              label: (
                <SegmentLabel
                  text={option.label}
                  keyName={String(index + 1)}
                  checked={current === option.value}
                  showKeys={showKeys}
                />
              ),
            }))}
          />
        );
      }
      return (
        <OptionChoices
          question={question}
          options={options}
          selected={current ? [current] : []}
          multi={false}
          onToggle={(next) => onChange(next)}
          cursor={cursor}
          showKeys={showKeys}
          disabled={disabled}
        />
      );
    }

    case "multi-select": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <OptionChoices
          question={question}
          options={question.options ?? []}
          selected={selected}
          multi
          onToggle={(next) =>
            onChange(
              selected.includes(next) ? selected.filter((v) => v !== next) : [...selected, next],
            )
          }
          cursor={cursor}
          showKeys={showKeys}
          disabled={disabled}
        />
      );
    }

    case "text": {
      const common = {
        placeholder: question.placeholder || "Type your answer…",
        value: typeof value === "string" ? value : "",
        disabled,
        "aria-label": question.label,
        "aria-keyshortcuts": onSubmitShortcut ? "Control+Enter Meta+Enter" : undefined,
        className: "text-base sm:text-sm",
      };
      return (
        <div className="flex flex-col gap-1">
          {question.multiline ? (
            <Textarea
              {...common}
              rows={3}
              className={cn(common.className, "min-h-20 resize-y")}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <Input
              {...common}
              className={cn(common.className, "h-11 sm:h-9")}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
          {showKeys ? (
            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:flex">
              <KeyHint>Esc</KeyHint> leaves the field · <KeyHint>{MOD}</KeyHint>
              <KeyHint>↵</KeyHint> submits
            </span>
          ) : null}
        </div>
      );
    }

    default:
      return <span className="text-sm text-muted-foreground">Unsupported question type</span>;
  }
}
