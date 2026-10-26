import { AlertCircle, Search } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAgentFsMediaUrl, useCombSearch } from "@/api/hooks/use-agent-fs";
import { FileKindIcon } from "@/components/comb/file-icon";
import { useUrlDraft } from "@/components/comb/use-url-draft";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { fileIconKind } from "@/lib/comb/file-icons";
import { combPath } from "@/lib/comb/paths";
import {
  isSearchable,
  isUnknownOpError,
  MIN_NAME_QUERY_LENGTH,
  nextSearchMode,
  SEARCH_MODE_PARAM,
  SEARCH_OPS,
  SEARCH_QUERY_PARAM,
  type SearchHit,
  type SearchMode,
  type SnippetPart,
  searchModeFromParam,
  searchModeParam,
} from "@/lib/comb/search";
import { usePageShortcut } from "@/lib/json-render/use-page-shortcut";

type Drive = { orgId: string; driveId: string };

// File names first, then meaning, then exact words (`SEARCH_MODES`).
const MODES = [
  { value: "name", label: "File", tooltip: "File names, close matches too" },
  { value: "semantic", label: "Semantic", tooltip: "Files about the topic, by meaning" },
  { value: "text", label: "Text", tooltip: "Exact words inside files" },
] as const;

const PLACEHOLDERS: Record<SearchMode, string> = {
  name: "Search file names",
  text: "Search words in files",
  semantic: "Describe what you are looking for",
};

/** Image hits show a small preview, up to this many per list (each loads the image). */
const MAX_THUMBNAILS = 20;

/** The mode the next search opens in: the last one used in this page load. */
let lastMode: SearchMode = "name";

/** Marks the history entry that opening the search pushed, so closing it goes back. */
type HistoryState = { combSearch?: boolean } | null;

/**
 * The search button in the Comb header, with the `/` shortcut. The search
 * lives in the URL (`?q=` and `?mode=`): a link opens the same search, Back
 * closes it, and Back from an opened result shows it again.
 */
export function CombSearchButton({ drive }: { drive: Drive }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const open = searchParams.has(SEARCH_QUERY_PARAM);
  const query = searchParams.get(SEARCH_QUERY_PARAM) ?? "";
  const mode = searchModeFromParam(searchParams.get(SEARCH_MODE_PARAM));

  const withSearch = (next: { query: string; mode: SearchMode } | null) => {
    const params = new URLSearchParams(searchParams);
    if (next) {
      params.set(SEARCH_QUERY_PARAM, next.query);
      params.set(SEARCH_MODE_PARAM, searchModeParam(next.mode));
    } else {
      params.delete(SEARCH_QUERY_PARAM);
      params.delete(SEARCH_MODE_PARAM);
    }
    return params;
  };
  const openSearch = () => {
    if (open) return;
    // One history entry for the open search. Typing and mode changes replace it.
    setSearchParams(withSearch({ query: "", mode: lastMode }), { state: { combSearch: true } });
  };
  const update = (next: { query: string; mode: SearchMode }) => {
    lastMode = next.mode;
    setSearchParams(withSearch(next), { replace: true, state: location.state });
  };
  const close = () => {
    if ((location.state as HistoryState)?.combSearch) void navigate(-1);
    else setSearchParams(withSearch(null), { replace: true });
  };
  usePageShortcut("/", buttonRef, openSearch);

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
            onClick={openSearch}
          >
            <Search />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="flex items-center gap-1.5">
          Search files <Kbd aria-hidden>/</Kbd>
        </TooltipContent>
      </Tooltip>
      {open ? (
        <SearchDialog drive={drive} query={query} mode={mode} onChange={update} onClose={close} />
      ) : null}
    </>
  );
}

function SearchDialog({
  drive,
  query,
  mode,
  onChange,
  onClose,
}: {
  drive: Drive;
  query: string;
  mode: SearchMode;
  onChange: (next: { query: string; mode: SearchMode }) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const writeQuery = useCallback(
    (next: string) => onChange({ query: next, mode }),
    [onChange, mode],
  );
  const [draft, setDraft] = useUrlDraft(query, writeQuery);
  const debounced = useDebouncedValue(draft, 200);
  const search = useCombSearch(drive, mode, debounced);
  const inputRef = useRef<HTMLInputElement>(null);

  // A result opens in a new history entry: Back from it shows this search again.
  const open = (hit: SearchHit) => void navigate(combPath({ ...drive, path: hit.path }));
  const setMode = (next: SearchMode) => {
    onChange({ query: draft, mode: next });
    inputRef.current?.focus();
  };
  // Tab and Shift+Tab move between the modes. The arrows move through the
  // results. The dialog's focus trap must not see the Tab: it would move focus
  // out of the box. Enter after a failed search tries it again.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter" && search.error) {
      event.preventDefault();
      void search.refetch();
      return;
    }
    if (event.key !== "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    setMode(nextSearchMode(mode, event.shiftKey ? -1 : 1));
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
          Search by file name, by meaning, or by the words in files. Tab switches the mode. Enter
          opens the file.
        </DialogDescription>
        {/* The server ranks the results, so cmdk keeps their order and filters nothing. */}
        <Command shouldFilter={false} loop className="rounded-none bg-background">
          <CommandInput
            ref={inputRef}
            value={draft}
            onValueChange={setDraft}
            onKeyDown={onKeyDown}
            placeholder={PLACEHOLDERS[mode]}
            aria-label="Search query"
            aria-keyshortcuts="Tab Shift+Tab"
          />
          <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
            <div className="flex items-center gap-2">
              <SegmentedControl
                aria-label="Search mode"
                size="sm"
                value={mode}
                onValueChange={setMode}
                options={MODES}
              />
              <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
                <Kbd aria-hidden>Tab</Kbd> switches
              </span>
            </div>
            <SearchMeta search={search} mode={mode} query={debounced} />
          </div>
          {/* A new search starts at the top of the list. */}
          <CommandList key={`${mode}:${debounced}`} className="max-h-[min(60vh,28rem)] p-1">
            <SearchBody
              drive={drive}
              search={search}
              mode={mode}
              query={draft}
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
  drive,
  search,
  mode,
  query,
  debounced,
  onOpen,
}: {
  drive: Drive;
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
          : "Search the whole swarm drive. Tab switches the mode. Enter opens the file."}
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
          <>
            {/* Tab switches the mode, so the button is out of keyboard reach: say how. */}
            <p className="text-xs text-muted-foreground">
              Press <Kbd>Enter</Kbd> to try again.
            </p>
            <Button size="sm" variant="outline" onClick={() => void search.refetch()}>
              Try again
            </Button>
          </>
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
      {hits.map((hit, index) => (
        <CommandItem
          key={hit.path}
          value={hit.path}
          onSelect={() => onOpen(hit)}
          className="items-start gap-2.5 px-2.5 py-2"
        >
          {index < MAX_THUMBNAILS && isImageHit(hit) ? (
            <SearchThumbnail file={{ ...drive, path: hit.path }} name={hit.name} />
          ) : (
            <FileKindIcon name={hit.name} isFolder={false} className="mt-0.5" />
          )}
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

/** An image hit: an image file by name, or a semantic hit on an image. */
function isImageHit(hit: SearchHit): boolean {
  return hit.chip === "Image" || fileIconKind(hit.name, false) === "image";
}

/**
 * A small preview of an image hit. agent-fs has no thumbnail op, so it loads
 * the image itself (`useAgentFsMediaUrl`). The icon shows while it loads and
 * when it cannot.
 */
function SearchThumbnail({ file, name }: { file: Drive & { path: string }; name: string }) {
  const media = useAgentFsMediaUrl(file, "image");
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = media.url !== failedUrl ? media.url : null;
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-muted/40">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailedUrl(url)}
          className="size-full object-cover"
        />
      ) : (
        <FileKindIcon name={name} isFolder={false} />
      )}
    </span>
  );
}
