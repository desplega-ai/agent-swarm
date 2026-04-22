import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { SwarmConfig } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { IntegrationField } from "@/lib/integrations-catalog";
import { cn } from "@/lib/utils";

// The server returns "********" for secret values unless ?includeSecrets=true.
// We use this sentinel to decide when to show the masked read-only view vs a
// live editable input. Matches the mask used by `src/be/db.ts`.
const SECRET_MASK_SENTINEL = "********";

interface FieldRendererProps {
  field: IntegrationField;
  existingConfig?: SwarmConfig;
  value: string;
  markedForReplace: boolean;
  onChange: (value: string) => void;
  onMarkForReplace: () => void;
  onUnmarkForReplace: () => void;
}

export function FieldRenderer({
  field,
  existingConfig,
  value,
  markedForReplace,
  onChange,
  onMarkForReplace,
  onUnmarkForReplace,
}: FieldRendererProps) {
  const [copied, setCopied] = useState(false);
  const inputId = `field-${field.key}`;

  async function handleCopyKey() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(field.key);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — degrade silently.
    }
  }

  // Secret already stored: show masked read-only + Replace until the user
  // explicitly opts into editing.
  const maskedServerValue =
    field.isSecret && existingConfig !== undefined && existingConfig.value === SECRET_MASK_SENTINEL;
  const showMaskedReadOnly = maskedServerValue && !markedForReplace;

  const poolSize =
    field.credentialPool && value.includes(",")
      ? value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean).length
      : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId} className="flex items-center gap-1">
          <span>{field.label}</span>
          {field.required && <span className="text-red-400 text-xs">*</span>}
        </Label>
        <code
          className="text-[10px] font-mono text-muted-foreground select-text"
          title={`Config key ${field.key}`}
        >
          {field.key}
        </code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-5 w-5"
          onClick={handleCopyKey}
          aria-label={`Copy key ${field.key}`}
          title={`Copy ${field.key}`}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>

      {showMaskedReadOnly ? (
        <div className="flex gap-2 items-center">
          <Input
            id={inputId}
            readOnly
            value="••••••"
            className="font-mono bg-muted/40"
            aria-describedby={field.helpText ? `${inputId}-help` : undefined}
          />
          <Button type="button" size="sm" variant="outline" onClick={onMarkForReplace}>
            Replace
          </Button>
        </div>
      ) : (
        <>
          {renderInput({ field, inputId, value, onChange })}
          {markedForReplace && maskedServerValue && (
            <button
              type="button"
              onClick={onUnmarkForReplace}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Cancel — keep existing value
            </button>
          )}
        </>
      )}

      {poolSize > 1 && (
        <div className="text-[10px] text-muted-foreground">
          <span className="inline-flex items-center rounded-md bg-muted/60 px-1.5 py-0.5 font-medium">
            {poolSize} keys in pool
          </span>
        </div>
      )}

      {field.helpText && (
        <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
          {field.helpText}
        </p>
      )}
    </div>
  );
}

function renderInput({
  field,
  inputId,
  value,
  onChange,
}: {
  field: IntegrationField;
  inputId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          id={inputId}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn("font-mono text-xs min-h-[120px]")}
          aria-describedby={field.helpText ? `${inputId}-help` : undefined}
        />
      );
    case "select":
      return (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={inputId}>
            <SelectValue placeholder={field.placeholder ?? "Select..."} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "boolean":
      return (
        <div className="flex items-center gap-2">
          <Switch
            id={inputId}
            checked={value === "true"}
            onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
          />
          <Label htmlFor={inputId} className="text-xs text-muted-foreground">
            {value === "true" ? "Enabled" : "Disabled"}
          </Label>
        </div>
      );
    case "password":
      return (
        <Input
          id={inputId}
          type="password"
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          aria-describedby={field.helpText ? `${inputId}-help` : undefined}
        />
      );
    default:
      return (
        <Input
          id={inputId}
          type="text"
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={field.helpText ? `${inputId}-help` : undefined}
        />
      );
  }
}
