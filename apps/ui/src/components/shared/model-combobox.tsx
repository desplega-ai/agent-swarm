import { Check, ChevronsUpDown, Lock } from "lucide-react";
import { useState } from "react";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { Badge } from "@/components/ui/badge";
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
import type { ModelCost, ModelGroup, ModelOption } from "@/lib/agent-runtime-models";
import { formatCost as sharedFormatCost } from "@/lib/cost-format";
import { cn } from "@/lib/utils";

// Phase 12a — call the shared `formatCost` utility and adapt its return type
// (this component's call sites expect `null` for missing values rather than
// the shared utility's placeholder string).
export function formatCost(value: number | undefined): string | null {
  if (value === undefined || value === null) return null;
  return sharedFormatCost(value);
}

export function formatContext(tokens: number | undefined): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

/** Catalog statuses that mean "do not start new work on this model". */
const RETIRING_STATUSES = new Set(["deprecated", "legacy"]);

/** "deprecated" / "legacy" in the warning tone, any other catalog status (beta, alpha) neutral. */
export function ModelStatusBadge({ status }: { status: string | undefined }) {
  if (!status) return null;
  return (
    <Badge
      variant="outline"
      size="tag"
      className={cn(
        RETIRING_STATUSES.has(status.toLowerCase()) &&
          "border-status-warning/30 text-status-warning-strong",
      )}
    >
      {status}
    </Badge>
  );
}

/** "Cache read $0.20 / write $2.50" for the rates a model has, `null` when it has none. */
export function formatCacheRates(cost: ModelCost | undefined): string | null {
  const read = formatCost(cost?.cache_read);
  const write = formatCost(cost?.cache_write);
  if (!read && !write) return null;
  return [read ? `read ${read}` : null, write ? `write ${write}` : null]
    .filter(Boolean)
    .join(" / ");
}

function ModelPrice({
  cost,
  contextWindow,
}: {
  cost: ModelCost | undefined;
  contextWindow: number | undefined;
}) {
  const inCost = formatCost(cost?.input);
  const outCost = formatCost(cost?.output);
  const ctx = formatContext(contextWindow);
  if (!inCost && !outCost && !ctx) return null;
  return (
    <span className="ml-2 hidden shrink-0 flex-col items-end text-[10px] leading-tight text-muted-foreground sm:flex">
      {(inCost || outCost) && (
        <span className="font-mono tabular-nums">
          {inCost ?? "?"} <span className="opacity-60">in</span> · {outCost ?? "?"}{" "}
          <span className="opacity-60">out</span>
        </span>
      )}
      {ctx && <span className="opacity-70">{ctx} ctx</span>}
    </span>
  );
}

interface ModelComboboxProps {
  value: string;
  onChange: (next: string) => void;
  groups: ModelGroup[];
  selected: ModelOption | null;
  placeholder?: string;
  creatable?: boolean;
  /**
   * Adds a first entry that clears the value (`onChange("")`), for a field
   * where "no model" is a real choice, such as "Default". The trigger shows
   * `placeholder` while the value is empty.
   */
  clearLabel?: string;
}

export function ModelCombobox({
  value,
  onChange,
  groups,
  selected,
  placeholder = "Select model",
  creatable = false,
  clearLabel,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const customValue = search.trim();
  const exactMatch = groups.some((group) =>
    group.models.some((option) => option.id === customValue),
  );

  function choose(nextValue: string) {
    onChange(nextValue);
    setSearch("");
    setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {selected ? <ProviderIcon provider={selected.providerId} className="h-4 w-4" /> : null}
            <span className="truncate">{selected ? selected.label : value || placeholder}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) min-w-[360px] max-w-[calc(100vw-2rem)] p-0"
        align="start"
      >
        <Command
          filter={(itemValue, search) => {
            const haystack = itemValue.toLowerCase();
            const needle = search.toLowerCase().trim();
            if (!needle) return 1;
            const tokens = needle.split(/\s+/);
            return tokens.every((t) => haystack.includes(t)) ? 1 : 0;
          }}
        >
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={creatable ? "Search or enter a model ID..." : "Search models..."}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {creatable ? "Type a model ID to use it." : "No models match."}
            </CommandEmpty>
            {clearLabel ? (
              <CommandGroup>
                <CommandItem value={`${clearLabel} default none`} onSelect={() => choose("")}>
                  <Check className={cn("h-4 w-4", value ? "opacity-0" : "opacity-100")} />
                  <span className="truncate">{clearLabel}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {creatable && customValue && !exactMatch ? (
              <CommandGroup heading="Custom">
                <CommandItem value={customValue} onSelect={() => choose(customValue)}>
                  <span className="truncate">
                    Use <span className="font-mono">{customValue}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map((group) => (
              <CommandGroup
                key={group.provider}
                heading={
                  <span className="flex flex-col gap-0.5">
                    <span className="flex items-center gap-1.5">
                      {!group.enabled && <Lock className="h-3 w-3" />}
                      {group.provider}
                    </span>
                    {!group.enabled && group.disabledReason ? (
                      <span className="font-normal text-[10px] text-muted-foreground normal-case">
                        {group.disabledReason}
                      </span>
                    ) : null}
                  </span>
                }
              >
                {group.models.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.label} ${option.id} ${option.provider}`}
                    disabled={!group.enabled}
                    onSelect={() => choose(option.id)}
                  >
                    <Check
                      className={cn("h-4 w-4", value === option.id ? "opacity-100" : "opacity-0")}
                    />
                    <ProviderIcon provider={option.providerId} className="h-4 w-4" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{option.label}</span>
                        <ModelStatusBadge status={option.status} />
                      </span>
                      <span className="truncate text-xs text-muted-foreground">{option.id}</span>
                    </span>
                    <ModelPrice cost={option.cost} contextWindow={option.contextWindow} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
