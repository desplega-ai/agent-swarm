"use client";

import { defaultFilter } from "cmdk";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Optional icon rendered to the left of the label inside the option row. */
  icon?: ReactNode;
  /** Optional secondary text shown right-aligned (e.g. agent role, "lead"). */
  hint?: string;
}

interface SearchableSelectBaseProps {
  options: SearchableSelectOption[];
  /** Placeholder shown when no value matches an option. */
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  triggerClassName?: string;
  contentClassName?: string;
  /** Freeze the current selection (e.g. while an unsaved edit is bound to it). */
  disabled?: boolean;
  /** Show the type-to-filter field. Default true. */
  searchable?: boolean;
  /** Trigger id, for an external `<label htmlFor>`. */
  id?: string;
  /** Accessible name when no label points at the trigger. */
  "aria-label"?: string;
  /** Attributes for the portalled list, e.g. an app surface's `data-theme`. */
  contentAttrs?: { "data-theme"?: string };
  /** Called with the typed search text, e.g. to load options from the server. */
  onSearchChange?: (search: string) => void;
}

export interface SearchableSelectProps extends SearchableSelectBaseProps {
  value: string;
  onChange: (next: string) => void;
}

export interface SearchableMultiSelectProps extends SearchableSelectBaseProps {
  values: string[];
  /** Receives the picked values in option order. */
  onChange: (next: string[]) => void;
}

/**
 * Ranked match. Every search token found as a substring ranks first ("lea" +
 * "worker" both narrow); a fuzzy subsequence match (cmdk scoring, "tmln" finds
 * "timeline") ranks below it. Within each band, cmdk's score orders the list.
 */
export function tokenFilter(itemValue: string, search: string): number {
  const needle = search.toLowerCase().trim();
  if (!needle) return 1;
  const haystack = itemValue.toLowerCase();
  const fuzzy = defaultFilter(haystack, needle);
  const allTokens = needle.split(/\s+/).every((token) => haystack.includes(token));
  return allTokens ? 0.5 + fuzzy / 2 : fuzzy / 2;
}

/**
 * Single-select combobox with fuzzy filtering. Use for filter dropdowns whose
 * option list is long enough that scanning beats clicking through. Tokenized
 * AND match so "lea" + " worker" both narrow.
 */
export function SearchableSelect({ value, onChange, ...base }: SearchableSelectProps) {
  const selected = base.options.find((o) => o.value === value);
  return (
    <OptionsCombobox
      {...base}
      isSelected={(option) => option === value}
      onPick={onChange}
      closeOnPick
      triggerContent={
        <>
          {selected?.icon}
          <span className="truncate">{selected?.label ?? base.placeholder ?? "Select…"}</span>
        </>
      }
    />
  );
}

/**
 * Multi-select twin of `SearchableSelect`: the list stays open while you
 * toggle, and the trigger shows the first pick plus a "+N" count.
 */
export function SearchableMultiSelect({ values, onChange, ...base }: SearchableMultiSelectProps) {
  const picked = base.options.filter((o) => values.includes(o.value));
  const toggle = (value: string) => {
    const on = new Set(values);
    if (on.has(value)) on.delete(value);
    else on.add(value);
    onChange(base.options.filter((o) => on.has(o.value)).map((o) => o.value));
  };
  return (
    <OptionsCombobox
      {...base}
      isSelected={(option) => values.includes(option)}
      onPick={toggle}
      triggerContent={
        picked.length === 0 ? (
          <span className="truncate">{base.placeholder ?? "Select…"}</span>
        ) : (
          <>
            {picked[0]?.icon}
            <span className="truncate">{picked[0]?.label}</span>
            {picked.length > 1 ? (
              <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
                +{picked.length - 1}
              </span>
            ) : null}
          </>
        )
      }
    />
  );
}

function OptionsCombobox({
  options,
  searchPlaceholder = "Search…",
  emptyLabel = "No matches.",
  triggerClassName,
  contentClassName,
  disabled = false,
  searchable = true,
  id,
  "aria-label": ariaLabel,
  contentAttrs,
  onSearchChange,
  isSelected,
  onPick,
  closeOnPick = false,
  triggerContent,
}: SearchableSelectBaseProps & {
  isSelected: (value: string) => boolean;
  onPick: (value: string) => void;
  closeOnPick?: boolean;
  triggerContent: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open && !disabled}
          disabled={disabled}
          className={cn("justify-between font-normal", triggerClassName)}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">{triggerContent}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        {...contentAttrs}
        // At least as wide as the trigger, as wide as the longest option, capped so a
        // long list never runs off a phone. A narrow trigger no longer truncates
        // every option to the same prefix.
        className={cn(
          "w-max min-w-[max(220px,var(--radix-popover-trigger-width))] max-w-[min(560px,90vw)] p-0",
          contentClassName,
        )}
        align="start"
      >
        <Command filter={tokenFilter}>
          {searchable ? (
            <CommandInput placeholder={searchPlaceholder} onValueChange={onSearchChange} />
          ) : null}
          <CommandList className="max-h-72">
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => {
                const selected = isSelected(option.value);
                return (
                  <CommandItem
                    key={option.value}
                    value={`${option.label} ${option.value} ${option.hint ?? ""}`}
                    data-checked={selected || undefined}
                    onSelect={() => {
                      onPick(option.value);
                      if (closeOnPick) setOpen(false);
                    }}
                  >
                    <Check
                      className={cn("h-4 w-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
                    />
                    {option.icon}
                    <span className="min-w-0 [overflow-wrap:anywhere]" title={option.label}>
                      {option.label}
                    </span>
                    {option.hint ? (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {option.hint}
                      </span>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
