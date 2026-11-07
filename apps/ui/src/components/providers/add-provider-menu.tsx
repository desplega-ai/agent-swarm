import { Check, ChevronDown, Plus } from "lucide-react";
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
import { AI_PROVIDER_GROUPS, AI_PROVIDERS } from "@/lib/ai-providers";
import { ProviderLogo } from "./provider-logo";

/**
 * "Add provider": every supported LLM provider, grouped (Subscriptions, API
 * keys, Gateways), searchable by name or harness. A provider that is set up
 * shows a check and its key count. A pick opens the side panel.
 */
export function AddProviderMenu({
  configured,
  onPick,
}: {
  /** Provider id to its count ("3 tokens"), or "Set up" for a provider without a pool. */
  configured: Record<string, string>;
  onPick: (providerId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" className="shrink-0">
          <Plus className="size-4" />
          Add provider
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] p-0">
        <Command
          // Match the name, the type and the harnesses, not the internal id.
          filter={(value, search, keywords) => {
            const haystack = [value, ...(keywords ?? [])].join(" ").toLowerCase();
            return haystack.includes(search.trim().toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder={`Search ${AI_PROVIDERS.length} providers`} />
          <CommandList className="max-h-[min(28rem,60vh)]">
            <CommandEmpty>No provider matches.</CommandEmpty>
            {AI_PROVIDER_GROUPS.map((group) => (
              <CommandGroup key={group.id} heading={group.label}>
                {AI_PROVIDERS.filter((p) => p.group === group.id).map((provider) => {
                  const done = configured[provider.id];
                  return (
                    <CommandItem
                      key={provider.id}
                      value={provider.name}
                      keywords={[provider.type, ...provider.harnesses]}
                      onSelect={() => {
                        setOpen(false);
                        onPick(provider.id);
                      }}
                      className="gap-2.5"
                    >
                      <ProviderLogo provider={provider} size="sm" />
                      <span className="shrink-0 font-medium">{provider.name}</span>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {provider.harnesses.join(", ")}
                      </span>
                      {done ? (
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          <Check aria-hidden className="size-3.5 text-status-success-strong" />
                          {done}
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
