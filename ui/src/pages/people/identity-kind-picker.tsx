import { Check, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getIntegrationLabel, IntegrationIcon } from "./integration-icons";

/**
 * Identity-kind picker — preset chips for the four auto-link sources
 * (Slack/GitHub/Linear/GitLab) plus an "Other…" affordance that surfaces a
 * free-text input. The free-text branch is allowed at the storage layer
 * (`user_external_ids.kind` has no CHECK constraint) but won't appear in the
 * Unmapped triage queue (UNMAPPED_KINDS in src/http/users.ts is hard-coded).
 *
 * We surface that limitation inline with a small warning so operators aren't
 * surprised when a `discord` identity never shows up in the triage list.
 */

export const PRESET_KINDS = ["slack", "github", "linear", "gitlab"] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

export function isPresetKind(kind: string): kind is PresetKind {
  return (PRESET_KINDS as readonly string[]).includes(kind);
}

/**
 * Inline warning shown when a non-preset kind is selected. Re-exported so
 * callers can render the same copy in different layouts (e.g. inline under
 * the row vs. dialog-wide footer).
 */
export function CustomKindWarning({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-1.5 text-[11px] leading-snug text-status-warning-strong",
        className,
      )}
    >
      <TriangleAlert className="h-3.5 w-3.5 mt-px shrink-0" />
      <span>
        Custom kinds won't appear in the Unmapped triage queue — Slack, GitHub, Linear and GitLab
        webhooks are the only auto-link sources today.
      </span>
    </div>
  );
}

interface IdentityKindPickerProps {
  value: string;
  onChange: (next: string) => void;
  /** Visual size; default is the dense `row` for use inside identity rows. */
  size?: "row" | "default";
  /** Disable the trigger entirely (used by resolve-create when kind is locked). */
  disabled?: boolean;
}

/**
 * Chip-row + Other... popover.
 *
 * Layout: four preset chips on the left, then a divider, then an "Other…"
 * button that opens a Command-driven combobox letting the operator (a) re-pick
 * any preset, or (b) type and confirm a custom kind. When a custom kind is
 * active the button labels itself with the live custom value (e.g. "discord").
 */
export function IdentityKindPicker({
  value,
  onChange,
  size = "row",
  disabled = false,
}: IdentityKindPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const isCustom = value !== "" && !isPresetKind(value);
  const customLabel = isCustom ? value : "Other";

  const chipSize = size === "row" ? "h-7 px-2 text-[11px]" : "h-8 px-2.5 text-xs";
  const iconSize = size === "row" ? "h-3.5 w-3.5" : "h-4 w-4";

  function pick(k: string) {
    onChange(k);
    setOpen(false);
    setSearch("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {PRESET_KINDS.map((k) => {
        const active = value === k;
        return (
          <button
            type="button"
            key={k}
            disabled={disabled}
            onClick={() => onChange(k)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors",
              chipSize,
              active
                ? "border-foreground/40 bg-foreground/10 text-foreground"
                : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              disabled &&
                "opacity-50 cursor-not-allowed hover:border-border hover:text-muted-foreground",
            )}
          >
            <IntegrationIcon kind={k} className={cn(iconSize, "shrink-0")} />
            <span>{getIntegrationLabel(k)}</span>
          </button>
        );
      })}

      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />

      <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors",
              chipSize,
              isCustom
                ? "border-foreground/40 bg-foreground/10 text-foreground"
                : "border-dashed border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              disabled && "opacity-50 cursor-not-allowed",
            )}
          >
            <IntegrationIcon
              kind={isCustom ? value : "other"}
              className={cn(iconSize, "shrink-0")}
            />
            <span className="normal-case">
              {customLabel}
              {isCustom ? "" : "…"}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[240px] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Type a custom kind…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>Type any kind and press enter.</CommandEmpty>
              {search.trim() && !isPresetKind(search.trim().toLowerCase()) && (
                <CommandGroup heading="Custom">
                  <CommandItem
                    value={`custom:${search.trim()}`}
                    onSelect={() => pick(search.trim().toLowerCase())}
                  >
                    <Check
                      className={cn(
                        "mr-2 h-4 w-4",
                        value === search.trim().toLowerCase() ? "opacity-100" : "opacity-0",
                      )}
                    />
                    Use "<span className="font-mono">{search.trim().toLowerCase()}</span>"
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup heading="Presets">
                {PRESET_KINDS.map((k) => (
                  <CommandItem key={k} value={k} onSelect={() => pick(k)}>
                    <IntegrationIcon kind={k} className="mr-2 h-4 w-4 text-foreground/80" />
                    {getIntegrationLabel(k)}
                    <Check
                      className={cn("ml-auto h-4 w-4", value === k ? "opacity-100" : "opacity-0")}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
