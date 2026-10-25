import { useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, Upload, X } from "lucide-react";
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { agentFsKey, agentFsLsQuery, useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { FileKindIcon } from "@/components/comb/file-icon";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { AgentFsError } from "@/lib/agent-fs/client";
import { baseName, combPath, type DrivePath, parentFolder } from "@/lib/comb/paths";
import {
  dropSources,
  filesFromDrop,
  formatLimit,
  isFinished,
  keepBothPath,
  type PutFn,
  UPLOAD_MESSAGE,
  type UploadInput,
  type UploadItem,
  UploadQueue,
  uploadLimitBytes,
  uploadTargetPath,
} from "@/lib/comb/upload";

// One queue for the page load, so uploads keep running (and stay listed)
// while the person moves between folders.
const queue = new UploadQueue({
  isConflict: (error) => error instanceof AgentFsError && error.status === 409,
  isAbort: (error) => error instanceof AgentFsError && error.code === "ABORTED",
  onDrained: ({ done, failed }) => {
    if (failed > 0) toast.error(`Uploaded ${done}, ${failed} failed`);
    else toast.success(done === 1 ? "Uploaded 1 file" : `Uploaded ${done} files`);
  },
});

function useUploadItems(): UploadItem[] {
  return useSyncExternalStore(queue.subscribe, queue.getItems, queue.getItems);
}

/**
 * Upload into `folder` with the connected human's key: create-only, so a
 * taken name waits for Keep both or Skip. A landed file refreshes the drive's
 * folder listings. Null while Comb is not connected.
 */
function useFolderUploader(folder: DrivePath) {
  const access = useAgentFsAccess();
  const { maxUploadBytes } = useAgentFs();
  const queryClient = useQueryClient();
  const { client } = access;
  const upload = useCallback(
    (inputs: UploadInput[]) => {
      if (!client || inputs.length === 0) return;
      const put: PutFn = (path, file, { signal, onProgress }) =>
        client
          .putRaw(folder.orgId, folder.driveId, path, file, {
            ifNoneMatch: true,
            message: UPLOAD_MESSAGE,
            signal,
            onProgress,
          })
          .then((result) => {
            void queryClient.invalidateQueries({
              queryKey: agentFsKey(
                access.endpoint,
                access.userId,
                folder.orgId,
                folder.driveId,
                "ls",
              ),
            });
            return result;
          });
      queue.enqueue(
        { orgId: folder.orgId, driveId: folder.driveId },
        inputs.map(({ file, relativePath }) => ({
          file,
          path: uploadTargetPath(folder.path, relativePath),
        })),
        put,
        uploadLimitBytes(maxUploadBytes),
      );
    },
    [client, folder, maxUploadBytes, queryClient, access.endpoint, access.userId],
  );
  return client ? upload : null;
}

/** The folder header's Upload button (a file picker, several files at once). */
export function UploadButton({ folder }: { folder: DrivePath }) {
  const upload = useFolderUploader(folder);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          // Reset, so picking the same file again fires a change.
          event.currentTarget.value = "";
          upload?.(files.map((file) => ({ file, relativePath: file.name })));
        }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-label="Upload files"
            disabled={!upload}
            onClick={() => inputRef.current?.click()}
          >
            <Upload />
            <span className="hidden sm:inline">Upload</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Upload files here, or drop them on the folder</TooltipContent>
      </Tooltip>
    </>
  );
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * The folder view as a drop target. Dropped folders keep their structure. An
 * outline shows while files are dragged over it.
 */
export function UploadDropZone({ folder, children }: { folder: DrivePath; children: ReactNode }) {
  const upload = useFolderUploader(folder);
  const { maxUploadBytes } = useAgentFs();
  // dragenter and dragleave fire for every child, so count them.
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const where = folder.path === "/" ? "the drive root" : folder.path;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (!upload || !hasFiles(event)) return;
        event.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (!upload || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!upload || !hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        if (!upload || !hasFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        // The item list empties after the event, so read the entries now.
        const { entries, files } = dropSources(event.dataTransfer.items);
        void filesFromDrop(entries, files).then(upload, (error: unknown) => {
          toast.error("Could not read the dropped files", {
            description: error instanceof Error ? error.message : undefined,
          });
        });
      }}
    >
      {/* The folder scrolls as one page when its parts (home, listing, comments) do not fit. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">{children}</div>
      {over ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85">
          <div className="flex flex-col items-center gap-2 px-6 text-center">
            <Upload className="size-6 text-primary" aria-hidden />
            <p className="text-sm font-medium">Drop to upload into {where}</p>
            <p className="text-xs text-muted-foreground">
              Folders keep their structure. Files over{" "}
              {formatLimit(uploadLimitBytes(maxUploadBytes))} are skipped.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The uploads of this page load, with progress and the clash choices. Hidden when empty. */
export function UploadList() {
  const items = useUploadItems();
  const access = useAgentFsAccess();
  const queryClient = useQueryClient();
  if (items.length === 0) return null;
  const finished = items.filter((item) => isFinished(item.status)).length;

  // Keep both: the next free name in the target folder, from a fresh listing.
  const keepBoth = async (item: UploadItem) => {
    const folder = parentFolder(item.path);
    const listing = await queryClient
      .fetchQuery(agentFsLsQuery(access, { ...item.drive, path: folder }))
      .catch(() => null);
    const taken = new Set(listing?.entries.map((entry) => entry.name) ?? []);
    taken.add(baseName(item.path));
    queue.keepBoth(item.id, keepBothPath(item.path, taken));
  };

  return (
    <section
      aria-label="Uploads"
      className="flex max-h-64 shrink-0 flex-col rounded-xl border border-border bg-card"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Upload className="size-4 text-muted-foreground" aria-hidden />
          Uploads
          <span className="text-muted-foreground tabular-nums">
            {finished} of {items.length}
          </span>
        </h2>
        {finished > 0 ? (
          <Button size="xs" variant="ghost" onClick={() => queue.clearFinished()}>
            Clear finished
          </Button>
        ) : null}
      </header>
      <ul className="min-h-0 flex-1 divide-y divide-border-subtle overflow-y-auto">
        {items.map((item) => (
          <UploadRow key={item.id} item={item} onKeepBoth={() => keepBoth(item)} />
        ))}
      </ul>
    </section>
  );
}

function UploadRow({ item, onKeepBoth }: { item: UploadItem; onKeepBoth: () => Promise<void> }) {
  const name = baseName(item.path);
  // Keep both reads the folder first. The buttons wait for it.
  const [resolving, setResolving] = useState(false);
  const cancellable = item.status === "queued" || item.status === "uploading";
  return (
    <li className="flex min-w-0 flex-col gap-1.5 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <UploadIcon item={item} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {item.status === "done" ? (
            <Link
              to={combPath({ ...item.drive, path: item.path })}
              className="truncate text-sm font-medium underline-offset-2 hover:underline"
            >
              {name}
            </Link>
          ) : (
            <span className="truncate text-sm font-medium">{name}</span>
          )}
          <span className="hidden truncate font-mono text-meta text-muted-foreground sm:inline">
            {parentFolder(item.path)}
          </span>
        </span>
        <UploadStatusText item={item} />
        {cancellable ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Cancel ${name}`}
            onClick={() => queue.cancel(item.id)}
          >
            <X />
          </Button>
        ) : null}
      </div>
      {item.status === "uploading" ? (
        <Progress
          value={Math.round(item.progress * 100)}
          aria-label={`Uploading ${name}`}
          className="h-1"
        />
      ) : null}
      {item.status === "conflict" ? (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <span className="text-xs text-muted-foreground">
            A file named {name} is already here.
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={resolving}
            onClick={() => {
              setResolving(true);
              void onKeepBoth().finally(() => setResolving(false));
            }}
          >
            Keep both
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={resolving}
            onClick={() => queue.skip(item.id)}
          >
            Skip
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function UploadIcon({ item }: { item: UploadItem }) {
  if (item.status === "done")
    return <Check className="size-4 shrink-0 text-status-success-strong" aria-hidden />;
  if (item.status === "error" || item.status === "rejected") {
    return <CircleAlert className="size-4 shrink-0 text-status-error-strong" aria-hidden />;
  }
  return <FileKindIcon name={item.path} isFolder={false} />;
}

function UploadStatusText({ item }: { item: UploadItem }) {
  const text = (() => {
    switch (item.status) {
      case "queued":
        return "Waiting";
      case "uploading":
        return `${Math.round(item.progress * 100)}%`;
      case "done":
        return "Uploaded";
      case "conflict":
        return "Name taken";
      case "skipped":
        return "Skipped";
      case "rejected":
      case "error":
        return item.error ?? "Upload failed";
    }
  })();
  const failed = item.status === "error" || item.status === "rejected";
  return (
    <span
      className={
        failed
          ? "max-w-[50%] shrink-0 truncate text-xs text-status-error-strong"
          : "shrink-0 text-xs tabular-nums text-muted-foreground"
      }
      title={failed ? text : undefined}
    >
      {text}
    </span>
  );
}
