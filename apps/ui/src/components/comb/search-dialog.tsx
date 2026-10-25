import { AlertCircle, FileText, Search } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCombSearch } from "@/api/hooks/use-agent-fs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { combPath } from "@/lib/comb/paths";
import {
  isSearchable,
  isUnknownOpError,
  MIN_NAME_QUERY_LENGTH,
  SEARCH_OPS,
  type SearchHit,
  type SearchMode,
  type SnippetPart,
} from "@/lib/comb/search";
import { usePageShortcut } from "@/lib/json-render/use-page-shortcut";

type Drive = { orgId: string; driveId: string };

const MODES = [
  { value: "name", label: "Name", tooltip: "File names, close matches too" },
  { value: "text", label: "Full text", tooltip: "Exact words inside files" },
  { value: "semantic", label: "Semantic", tooltip: "Files about the topic, by meaning" },
] as const;

const PLACEHOLDERS: Record<SearchMode, string> = {
  name: "Search file names",
  text: "Search words in files",
  semantic: "Describe what you are looking for",
};

/**
 * The search button in the Comb header, with the `/` shortcut. It owns the
 * dialog state, so the mode stays the same between searches on this page.
 */
export function CombSearchButton({ drive }: { drive: Drive }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("name");
  const buttonRef = useRef<HTMLButtonElement>(null);
  usePageShortcut("/", buttonRef, () => setOpen(true));

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={buttonRef}
            variant="ghost"
            size="icon-sm"
            aria-label="Search files"
            aria-keyshortcuts="/"
            onClick={() => setOpen(true)}
          >
            <Search />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex items-center gap-1.5">
          Search files <Kbd aria-hidden>/</Kbd>
        </TooltipContent>
      </Tooltip>
      {open ? (
        <SearchDialog
          drive={drive}
          mode={mode}
          onModeChange={setMode}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function SearchDialog({
  drive,
  mode,
  onModeChange,
  onClose,
}: {
  drive: Drive;
  mode: SearchMode;
  onModeChange: (mode: SearchMode) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 200);
  const search = useCombSearch(drive, mode, debounced);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = (hit: SearchHit) => {
    onClose();
    void navigate(combPath({ ...drive, path: hit.path }));
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogTitle className="sr-only">Search the swarm drive</DialogTitle>
        <DialogDescription className="sr-only">
          Search by file name, by the words in files, or by meaning. Enter opens the file.
        </DialogDescription>
        {/* The server ranks the results, so cmdk keeps their order and filters nothing. */}
        <Command shouldFilter={false} loop className="rounded-none bg-background">
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder={PLACEHOLDERS[mode]}
            aria-label="Search query"
          />
          <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
            <SegmentedControl
              aria-label="Search mode"
              size="sm"
              value={mode}
              onValueChange={(next) => {
                onModeChange(next);
                inputRef.current?.focus();
              }}
              options={MODES}
            />
            <SearchMeta search={search} mode={mode} query={debounced} />
          </div>
          {/* A new search starts at the top of the list. */}
          <CommandList key={`${mode}:${debounced}`} className="max-h-[min(60vh,28rem)] p-1">
            <SearchBody
              search={search}
              mode={mode}
              query={query}
              debounced={debounced}
              onOpen={open}
            />
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

type SearchState = ReturnType<typeof useCombSearch>;

/** "12 results" or "50 of 120", after the results arrive. */
function SearchMeta({
  search,
  mode,
  query,
}: {
  search: SearchState;
  mode: SearchMode;
  query: string;
}) {
  if (!isSearchable(mode, query) || !search.data || search.isPlaceholderData) {
    return search.isFetching ? <Spinner className="size-3.5 text-muted-foreground" /> : null;
  }
  const { hits, total } = search.data;
  const label =
    total > hits.length
      ? `${hits.length} of ${total}`
      : `${hits.length} ${hits.length === 1 ? "result" : "results"}`;
  return <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{label}</span>;
}

function SearchBody({
  search,
  mode,
  query,
  debounced,
  onOpen,
}: {
  search: SearchState;
  mode: SearchMode;
  query: string;
  debounced: string;
  onOpen: (hit: SearchHit) => void;
}) {
  if (!isSearchable(mode, query)) {
    return (
      <SearchNote>
        {query.trim() && mode === "name"
          ? `Type at least ${MIN_NAME_QUERY_LENGTH} characters.`
          : "Search the whole swarm drive. Enter opens the selected file."}
      </SearchNote>
    );
  }
  if (search.error) {
    const unsupported = isUnknownOpError(search.error, SEARCH_OPS[mode]);
    return (
      <div role="alert" className="flex flex-col items-center gap-2 px-6 py-8 text-center text-sm">
        <AlertCircle className="size-5 text-status-error-strong" aria-hidden />
        <p>
          {unsupported
            ? mode === "name"
              ? "This agent-fs has no name search. Update agent-fs to 0.18.5 or later."
              : "This agent-fs cannot run this search. Update agent-fs."
            : search.error.message || "Search failed."}
        </p>
        {unsupported ? null : (
          <Button size="sm" variant="outline" onClick={() => void search.refetch()}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  if (!search.data) {
    return (
      <SearchNote>
        <span className="inline-flex items-center gap-2">
          <Spinner className="size-3.5" /> Searching…
        </span>
      </SearchNote>
    );
  }
  const { hits, hint } = search.data;
  if (hits.length === 0 && !search.isPlaceholderData) {
    return (
      <SearchNote>
        <span className="block">No files match “{debounced.trim()}”.</span>
        {hint ? <span className="mt-1 block text-xs">{hint}</span> : null}
      </SearchNote>
    );
  }
  return (
    <>
      {hits.map((hit) => (
        <CommandItem
          key={hit.path}
          value={hit.path}
          onSelect={() => onOpen(hit)}
          className="items-start gap-2.5 px-2.5 py-2"
        >
          <FileText className="mt-0.5" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-medium">{hit.name}</span>
              <span className="truncate font-mono text-meta text-muted-foreground">
                {hit.folder}
              </span>
              {hit.chip ? (
                <Badge variant="outline" size="tag" className="ml-auto shrink-0">
                  {hit.chip}
                </Badge>
              ) : null}
            </span>
            {hit.snippet.length > 0 ? (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                <Snippet parts={hit.snippet} />
              </span>
            ) : null}
          </span>
        </CommandItem>
      ))}
      {hint ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );
}

/** The list's only child while there are no results (hints, loading, no match). */
function SearchNote({ children }: { children: ReactNode }) {
  return (
    <output className="block px-6 py-8 text-center text-sm text-muted-foreground">
      {children}
    </output>
  );
}

/** A snippet as text, with the matched words marked. Never parsed as HTML. */
function Snippet({ parts }: { parts: SnippetPart[] }) {
  return parts.map((part, index) =>
    part.hit ? (
      <mark key={index} className="rounded-xs bg-primary/25 text-inherit">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}
