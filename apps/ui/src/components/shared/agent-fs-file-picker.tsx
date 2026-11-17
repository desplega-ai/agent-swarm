/**
 * Search the swarm's agent-fs drive and pick one file. Inline (an input over
 * a result list), so it fits a form field, a popover, or an input box menu.
 * The search lives in `useAgentFsSearch`; this only renders it.
 */

import { FileIcon } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { type AgentFsSearchOptions, useAgentFsSearch } from "@/hooks/use-agent-fs-search";
import { cn } from "@/lib/utils";

export interface AgentFsPickedFile {
  orgId: string;
  driveId: string;
  /** Absolute drive path, e.g. "/users/u1/avatar.png". */
  path: string;
  name: string;
}

export interface AgentFsFilePickerProps extends AgentFsSearchOptions {
  onSelect: (file: AgentFsPickedFile) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function AgentFsFilePicker({
  onSelect,
  placeholder = "Search agent-fs files…",
  disabled,
  className,
  ...options
}: AgentFsFilePickerProps) {
  const [query, setQuery] = useState("");
  const { drive, hits, searchable, loading, error } = useAgentFsSearch(query, options);

  let empty = "No matching files.";
  if (!drive) empty = "agent-fs has no swarm drive yet.";
  else if (!searchable) empty = "Type at least two letters of a file name.";
  else if (error) empty = "Search failed. Try again.";
  else if (loading) empty = "Searching…";

  return (
    <Command
      shouldFilter={false}
      className={cn("rounded-md border border-input", className)}
      data-testid="agent-fs-file-picker"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={placeholder}
        disabled={disabled || !drive}
        aria-label="Search agent-fs files"
      />
      <CommandList className="max-h-48">
        <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">
          {empty}
        </CommandEmpty>
        {drive &&
          searchable &&
          hits.map((hit) => (
            <CommandItem
              key={hit.path}
              value={hit.path}
              disabled={disabled}
              onSelect={() => onSelect({ ...drive, path: hit.path, name: hit.name })}
              className="gap-2 text-xs"
            >
              <FileIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{hit.name}</span>
              <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
                {hit.folder}
              </span>
            </CommandItem>
          ))}
      </CommandList>
    </Command>
  );
}
