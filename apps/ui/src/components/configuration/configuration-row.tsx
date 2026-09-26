import { ExternalLink, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isTruthyConfigValue, useSwarmConfig } from "@/hooks/use-swarm-config";
import { AVATAR_COLOR_INPUT_FALLBACK } from "@/lib/agent-color";
import type { ConfigCatalogEntry } from "@/lib/configuration-catalog";
import { formatDuration, isJsonObject } from "@/lib/configuration-values";
import { cn } from "@/lib/utils";
import { ConfigurationMultiselect } from "./configuration-multiselect";
import { DurationInput } from "./duration-input";

// Radix `SelectItem` rejects an empty string value, so "fall back to the
// default" needs its own sentinel. It never reaches the API — picking it
// deletes the DB row instead.
const UNSET_SENTINEL = "__unset__";

interface SourceChip {
  label: string;
  className: string;
  title: string;
}

/**
 * Mirrors the per-field source chips on the integrations detail page
 * (`components/integrations/field-renderer.tsx`) so both surfaces read the
 * same way.
 */
function deriveSourceChip(inDb: boolean, inEnv: boolean): SourceChip | null {
  if (inDb) {
    return inEnv
      ? {
          label: "db+env",
          className: "bg-status-success/10 text-status-success-strong border-status-success/30",
          title: "Saved here and loaded into process.env. Live on the server.",
        }
      : {
          label: "db (pending reload)",
          className: "bg-status-active/10 text-status-active-strong border-status-active/30",
          title:
            "Saved here but not yet in process.env — reload or restart the API server to apply.",
        };
  }
  return inEnv
    ? {
        label: "env",
        className: "bg-status-info/10 text-status-info-strong border-status-info/30",
        title:
          "Set via deployment env (.env / docker) only. No saved value — saving here creates one that takes over on reload.",
      }
    : null;
}

export interface ConfigurationRowProps {
  entry: ConfigCatalogEntry;
  /** Whether the key is currently present in the API server's `process.env`. */
  inEnv: boolean;
}

export function ConfigurationRow({ entry, inEnv }: ConfigurationRowProps) {
  const { config, value: savedValue, save, reset, isSaving, isLoading } = useSwarmConfig(entry.key);
  const inputId = `config-${entry.key}`;
  const isPending = isSaving || isLoading;
  const sourceChip = deriveSourceChip(config !== undefined, inEnv);

  // Text/number rows are draft-edited and committed with an explicit Save.
  // Re-sync whenever the server value changes underneath us (save, reset,
  // reload, or another tab).
  const initialDraft =
    savedValue ?? (entry.kind === "multiselect" ? entry.defaultValue : undefined) ?? "";
  const [draft, setDraft] = useState(initialDraft);
  useEffect(() => {
    setDraft(initialDraft);
  }, [initialDraft]);

  const isDirty = draft !== initialDraft;
  const invalidDraft =
    entry.kind === "number"
      ? draft !== "" &&
        (!Number.isFinite(Number(draft)) ||
          (entry.unit !== undefined && !Number.isInteger(Number(draft))))
      : entry.kind === "json" && !isJsonObject(draft);

  // A key present in the server's `process.env` with no DB row: the API only
  // exposes presence, never the env value, so rendering a control seeded from
  // the catalog default would misreport the live setting. Show a read-only
  // marker until the operator explicitly opts into overriding it.
  const [isOverriding, setIsOverriding] = useState(false);
  const envOnly = inEnv && config === undefined;
  const showEnvOnly = envOnly && !isOverriding;

  // While overriding an env-only boolean/enum, the control edits a local draft
  // committed by an explicit Save — persisting on change would make the
  // initially displayed value (often exactly what the operator wants, e.g.
  // default "false" to override RBAC_ENABLED=true) impossible to save.
  const isDraftOverride = envOnly && isOverriding;
  const [choiceDraft, setChoiceDraft] = useState<string | null>(null);

  function beginOverride() {
    setDraft(
      entry.kind === "number" && !Number.isFinite(Number(entry.defaultValue))
        ? ""
        : (entry.defaultValue ?? ""),
    );
    setChoiceDraft(
      entry.kind === "boolean"
        ? isTruthyConfigValue(entry.defaultValue)
          ? "true"
          : "false"
        : (entry.defaultValue ?? null),
    );
    setIsOverriding(true);
  }

  // Once a DB row exists (or disappears again) drop back to the default view.
  useEffect(() => {
    if (config !== undefined) {
      setIsOverriding(false);
      setChoiceDraft(null);
    }
  }, [config]);

  function handleSave(value: string) {
    save(value, { description: entry.description });
  }

  function cancelOverride() {
    setDraft(initialDraft);
    setChoiceDraft(null);
    setIsOverriding(false);
  }

  const cancelOverrideButton = envOnly ? (
    <button
      type="button"
      onClick={cancelOverride}
      className="text-xs text-muted-foreground underline hover:text-foreground shrink-0"
    >
      Cancel
    </button>
  ) : null;

  // A saved value equal to the default changes nothing, so a reset there is
  // a control with nothing to do. The slot stays reserved on `sm+` so every
  // row's control shares one right edge.
  const differsFromDefault =
    entry.kind === "boolean"
      ? isTruthyConfigValue(savedValue) !== isTruthyConfigValue(entry.defaultValue)
      : (savedValue ?? "") !== (entry.defaultValue ?? "");
  const resetButton =
    config && differsFromDefault ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8 shrink-0"
            onClick={reset}
            disabled={isPending}
            aria-label={`Reset ${entry.key} to its default`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Reset to default (removes the saved value)</TooltipContent>
      </Tooltip>
    ) : (
      <span aria-hidden="true" className="hidden h-8 w-8 shrink-0 sm:block" />
    );

  return (
    <div
      id={`setting-${entry.key}`}
      className="flex scroll-mt-6 flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
    >
      <div className="min-w-0 space-y-1 sm:flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor={showEnvOnly ? undefined : inputId} className="text-sm font-medium">
            {entry.label}
          </Label>
          <code className="font-mono text-[10px] text-muted-foreground select-text">
            {entry.key}
          </code>
          {entry.restartRequired && (
            <Badge
              variant="outline"
              size="tag"
              className="border-status-warning/30 text-status-warning-strong"
            >
              Restart required
            </Badge>
          )}
          {sourceChip && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "text-[9px] uppercase tracking-wide px-1.5 py-0 h-5 inline-flex items-center rounded-md border font-medium leading-none cursor-help",
                    sourceChip.className,
                  )}
                >
                  {sourceChip.label}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{sourceChip.title}</TooltipContent>
            </Tooltip>
          )}
          {entry.docsUrl && (
            <a
              href={entry.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Documentation for ${entry.key}`}
              title="Open documentation"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{entry.description}</p>
        {entry.defaultValue && (
          <p className="text-[11px] text-muted-foreground">
            Default:{" "}
            <code className="font-mono">
              {entry.unit ? formatDuration(entry.defaultValue, entry.unit) : entry.defaultValue}
            </code>
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0 sm:w-80 sm:justify-end">
        {showEnvOnly && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-muted-foreground cursor-help">
                  Set via environment
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                This key is set in the API server's environment. The dashboard can see that it is
                set, but not its value. Override to save a value here — it takes over on reload.
              </TooltipContent>
            </Tooltip>
            <Button type="button" size="sm" variant="outline" onClick={beginOverride}>
              Override
            </Button>
          </>
        )}

        {!showEnvOnly && entry.kind === "boolean" && (
          <>
            <Switch
              id={inputId}
              checked={
                isDraftOverride
                  ? choiceDraft === "true"
                  : isTruthyConfigValue(savedValue ?? entry.defaultValue)
              }
              disabled={isPending}
              onCheckedChange={(checked) => {
                const next = checked ? "true" : "false";
                if (isDraftOverride) {
                  setChoiceDraft(next);
                } else {
                  handleSave(next);
                }
              }}
            />
            {isDraftOverride && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isPending}
                onClick={() => handleSave(choiceDraft === "true" ? "true" : "false")}
              >
                Save
              </Button>
            )}
            {cancelOverrideButton}
            {resetButton}
          </>
        )}

        {!showEnvOnly && entry.kind === "enum" && (
          <>
            <Select
              value={
                isDraftOverride ? (choiceDraft ?? UNSET_SENTINEL) : savedValue || UNSET_SENTINEL
              }
              disabled={isPending}
              onValueChange={(next) => {
                if (isDraftOverride) {
                  setChoiceDraft(next === UNSET_SENTINEL ? null : next);
                  return;
                }
                if (next === UNSET_SENTINEL) {
                  reset();
                  return;
                }
                handleSave(next);
              }}
            >
              <SelectTrigger id={inputId} className="min-w-0 flex-1 sm:w-56 sm:flex-none">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET_SENTINEL}>
                  {entry.defaultValue ? `Default (${entry.defaultValue})` : "Not set"}
                </SelectItem>
                {savedValue && !entry.options?.includes(savedValue) && (
                  <SelectItem value={savedValue}>{savedValue} (unrecognized)</SelectItem>
                )}
                {(entry.options ?? []).map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isDraftOverride && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isPending || choiceDraft === null}
                onClick={() => choiceDraft !== null && handleSave(choiceDraft)}
              >
                Save
              </Button>
            )}
            {cancelOverrideButton}
            {resetButton}
          </>
        )}

        {!showEnvOnly && entry.kind !== "boolean" && entry.kind !== "enum" && (
          <>
            {entry.unit ? (
              <DurationInput
                id={inputId}
                value={draft}
                nativeUnit={entry.unit}
                defaultValue={entry.defaultValue}
                disabled={isPending}
                onChange={setDraft}
              />
            ) : entry.kind === "multiselect" ? (
              <ConfigurationMultiselect
                id={inputId}
                value={draft}
                options={entry.options ?? []}
                disabled={isPending}
                onChange={setDraft}
              />
            ) : entry.kind === "json" ? (
              <Textarea
                id={inputId}
                value={draft}
                placeholder={entry.defaultValue}
                disabled={isPending}
                onChange={(event) => setDraft(event.target.value)}
                aria-invalid={invalidDraft}
                className="min-w-0 font-mono text-xs"
                rows={4}
              />
            ) : (
              <>
                {entry.kind === "color" && (
                  <Input
                    type="color"
                    aria-label={`${entry.label} picker`}
                    value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : AVATAR_COLOR_INPUT_FALLBACK}
                    disabled={isPending}
                    onChange={(event) => setDraft(event.target.value)}
                    className="w-10 shrink-0 p-1"
                  />
                )}
                <Input
                  id={inputId}
                  type={entry.kind === "number" ? "number" : "text"}
                  step={entry.kind === "number" ? "any" : undefined}
                  value={draft}
                  placeholder={entry.placeholder ?? entry.defaultValue}
                  disabled={isPending}
                  onChange={(event) => setDraft(event.target.value)}
                  className="min-w-0 w-full font-mono text-xs"
                />
              </>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                (!isDirty && !isDraftOverride) ||
                isPending ||
                invalidDraft ||
                (entry.kind === "number" && draft === "" && !config)
              }
              onClick={() =>
                entry.kind === "number" && draft.trim() === "" ? reset() : handleSave(draft)
              }
            >
              Save
            </Button>
            {cancelOverrideButton}
            {resetButton}
            {invalidDraft && draft !== "" && (
              <p role="alert" className="w-full text-xs text-status-error-strong">
                {entry.kind === "json"
                  ? "Enter a valid JSON object."
                  : entry.unit
                    ? `Use a whole number of ${entry.unit}.`
                    : "Enter a finite number."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
