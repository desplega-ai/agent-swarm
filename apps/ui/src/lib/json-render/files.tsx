/**
 * `Files` and `File` — agent-fs folder listings and file views inside an app,
 * read as the VIEWER through their own agent-fs key (Comb's connection,
 * `useOptionalAgentFs()`), never through the swarm key. The drive is the comb
 * default org and drive from `/status`.
 * shortcut: one drive per swarm; add a "drive" prop when an app needs a second drive.
 *
 * Access control is agent-fs's: the viewer sees what their drive membership
 * allows. A viewer with no saved key gets a "Connect agent-fs" card that opens
 * Comb's connect flow; inside a chromeless iframe (no key for that storage
 * partition) the card links to the app in the dashboard instead.
 *
 * File views reuse Comb's viewers, except Markdown (the shared `MarkdownView`
 * with raw HTML shown as text) and HTML (its source, never a live preview).
 */

import type { InferComponentProps } from "@json-render/core";
import { AlertCircle, ChevronRight, FileQuestion, FolderOpen, HardDrive, Lock } from "lucide-react";
import { type ReactNode, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isAccessDenied, useAgentFsLs, useAgentFsStat } from "@/api/hooks/use-agent-fs";
import { ConnectCard } from "@/components/comb/connect-card";
import { DownloadButton, OpenInAgentFsButton } from "@/components/comb/file-actions";
import { FileKindIcon } from "@/components/comb/file-icon";
import { UploadButton, UploadDropZone, UploadList } from "@/components/comb/upload-zone";
import { VIEWERS } from "@/components/comb/viewers/file-viewer";
import { TextGate } from "@/components/comb/viewers/text-gate";
import { ViewerSkeleton } from "@/components/comb/viewers/viewer-skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { MarkdownView } from "@/components/shared/markdown-view";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { AgentFsError } from "@/lib/agent-fs/client";
import type { StatResult } from "@/lib/agent-fs/types";
import { getFileKind } from "@/lib/comb/file-kinds";
import type { DrivePath } from "@/lib/comb/paths";
import { formatBytes } from "@/lib/format-bytes";
import { cn } from "@/lib/utils";
import type { swarmCatalog } from "./catalog";
import { type FileRow, fileRows, folderCrumbs, initialFolder, toFolderPath } from "./files-model";

export type FilesProps = InferComponentProps<typeof swarmCatalog, "Files">;
export type FileProps = InferComponentProps<typeof swarmCatalog, "File">;
type Drive = Omit<DrivePath, "path">;

/** A bound path can be anything at runtime: only an absolute path without `..` loads. */
function usablePath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.split("/").includes("..");
}

function isNotFound(error: unknown): boolean {
  return error instanceof AgentFsError && error.status === 404;
}

// ─── Connection gate ────────────────────────────────────────────────────────

/** Renders `children` with the swarm drive once the viewer's agent-fs key works. */
export function AgentFsGate({ children }: { children: (drive: Drive) => ReactNode }) {
  const agentFs = useOptionalAgentFs();
  if (!agentFs || agentFs.state === "disabled") {
    return <EmptyState compact icon={HardDrive} title="agent-fs is not set up on this swarm" />;
  }
  if (agentFs.state === "loading") return <ViewerSkeleton />;
  if (agentFs.state === "needs-connect" || agentFs.state === "invalid-key") {
    return <ConnectPrompt invalidKey={agentFs.state === "invalid-key"} />;
  }
  if (agentFs.state === "unreachable") {
    return (
      <AlertCallout
        tone="error"
        icon={AlertCircle}
        title="Could not reach agent-fs"
        action={
          <Button size="sm" variant="outline" onClick={agentFs.retry}>
            Retry
          </Button>
        }
      >
        {agentFs.error?.message}
      </AlertCallout>
    );
  }
  if (!agentFs.orgId || !agentFs.driveId) {
    return <EmptyState compact icon={HardDrive} title="This swarm has no default agent-fs drive" />;
  }
  return children({ orgId: agentFs.orgId, driveId: agentFs.driveId });
}

/**
 * Not connected. In the dashboard: Comb's connect flow in a dialog. In a
 * chromeless iframe the browser partitions storage, so a key saved there does
 * not persist: link to the app in the dashboard instead.
 */
function ConnectPrompt({ invalidKey }: { invalidKey: boolean }) {
  const [open, setOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const embedded = searchParams.get("mode") === "chromeless" && window.self !== window.top;
  const title = invalidKey
    ? "agent-fs rejected your saved key"
    : "Connect agent-fs to see these files";
  if (embedded) {
    const dashboardUrl = new URL(window.location.href);
    dashboardUrl.searchParams.delete("mode");
    return (
      <EmptyState
        compact
        icon={Lock}
        title={title}
        description="Open this app in the dashboard to connect your agent-fs account."
        action={
          <Button asChild size="sm">
            <a href={dashboardUrl.toString()} target="_blank" rel="noreferrer">
              Open in dashboard
            </a>
          </Button>
        }
      />
    );
  }
  return (
    <>
      <EmptyState
        compact
        icon={Lock}
        title={title}
        description="Files load with your own agent-fs account."
        action={
          <Button size="sm" onClick={() => setOpen(true)}>
            Connect agent-fs
          </Button>
        }
      />
      {/* Connecting changes the state, which unmounts this prompt and the dialog. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="border-0 bg-transparent p-0 shadow-none sm:max-w-md"
        >
          <DialogTitle className="sr-only">Connect agent-fs</DialogTitle>
          <ConnectCard />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Files ──────────────────────────────────────────────────────────────────

export function FilesView({
  props,
  onSelect,
}: {
  props: FilesProps;
  onSelect: (row: FileRow) => void;
}) {
  const fill = props.fill === true;
  const body = usablePath(props.path) ? (
    <AgentFsGate>
      {(drive) => <FilesList drive={drive} props={props} onSelect={onSelect} />}
    </AgentFsGate>
  ) : (
    <EmptyState compact icon={FileQuestion} title="Not an agent-fs folder path" />
  );
  return (
    <Card
      className={cn("min-w-0 gap-0 overflow-hidden py-0", fill && "flex h-full min-h-0 flex-col")}
      data-testid="app-files"
    >
      {body}
    </Card>
  );
}

function FilesList({
  drive,
  props,
  onSelect,
}: {
  drive: Drive;
  props: FilesProps;
  onSelect: (row: FileRow) => void;
}) {
  const root = toFolderPath(props.path);
  const browser = props.mode === "browser";
  // The opened subfolder, remembered per root: a new `path` starts at its root.
  const [opened, setOpened] = useState(() => ({
    root,
    folder: browser ? initialFolder(root, props.selectedPath) : root,
  }));
  const folder = browser && opened.root === root ? opened.folder : root;
  const listing = useAgentFsLs({ ...drive, path: folder });
  const entries = listing.data?.entries;
  const rows = useMemo(() => (entries ? fileRows(folder, entries) : []), [entries, folder]);
  const fill = props.fill === true;

  let content: ReactNode;
  if (listing.data || isNotFound(listing.error)) {
    // A folder that does not exist yet is an empty folder.
    content =
      rows.length === 0 ? (
        <EmptyState compact icon={FolderOpen} title={props.emptyMessage ?? "No files yet"} />
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.path}>
              <button
                type="button"
                data-testid="app-files-row"
                aria-current={row.path === props.selectedPath ? "true" : undefined}
                onClick={() =>
                  browser && row.type === "directory"
                    ? setOpened({ root, folder: row.path })
                    : onSelect(row)
                }
                className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none aria-[current=true]:bg-primary/10"
              >
                <FileKindIcon name={row.name} isFolder={row.type === "directory"} />
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.type === "file" ? (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatBytes(row.size)}
                  </span>
                ) : null}
                {row.modifiedAt ? (
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {new Date(row.modifiedAt).toLocaleDateString()}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      );
  } else if (isAccessDenied(listing.error)) {
    content = (
      <EmptyState
        compact
        icon={Lock}
        title="You do not have access to this folder"
        description={folder}
      />
    );
  } else if (listing.error) {
    content = (
      <AlertCallout tone="error" icon={AlertCircle} title="Could not list the folder">
        {listing.error.message}
      </AlertCallout>
    );
  } else {
    content = <ViewerSkeleton />;
  }

  const upload = props.upload === true;
  const crumbs = browser && folder !== root;
  const list = (
    <div
      className={cn("min-w-0 overflow-y-auto", fill && "min-h-0 flex-1")}
      style={fill ? undefined : { maxHeight: props.maxHeight ?? "480px" }}
    >
      {content}
    </div>
  );

  return (
    <>
      {crumbs || upload ? (
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          {crumbs ? (
            <FolderCrumbs
              root={root}
              folder={folder}
              onOpen={(path) => setOpened({ root, folder: path })}
            />
          ) : (
            <span className="flex-1" />
          )}
          {upload ? <UploadButton folder={{ ...drive, path: folder }} /> : null}
        </div>
      ) : null}
      {upload ? (
        <>
          <UploadDropZone folder={{ ...drive, path: folder }}>{list}</UploadDropZone>
          <UploadList />
        </>
      ) : (
        list
      )}
    </>
  );
}

function FolderCrumbs({
  root,
  folder,
  onOpen,
}: {
  root: string;
  folder: string;
  onOpen: (path: string) => void;
}) {
  return (
    <nav aria-label="Folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5">
      {folderCrumbs(root, folder).map((crumb, index, all) => (
        <span key={crumb.path} className="flex items-center gap-1 text-sm">
          {index > 0 ? <ChevronRight aria-hidden className="size-3 text-muted-foreground" /> : null}
          {index === all.length - 1 ? (
            <span aria-current="location" className="font-medium">
              {crumb.label}
            </span>
          ) : (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onOpen(crumb.path)}
            >
              {crumb.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

// ─── File ───────────────────────────────────────────────────────────────────

export function FileView({ props }: { props: FileProps }) {
  const path = props.path;
  const fill = props.fill === true;
  let body: ReactNode;
  if (!path) {
    body = <EmptyState compact icon={FileQuestion} title="No file selected" />;
  } else if (!usablePath(path)) {
    body = <EmptyState compact icon={FileQuestion} title="Not an agent-fs file path" />;
  } else {
    body = <AgentFsGate>{(drive) => <FileBody file={{ ...drive, path }} />}</AgentFsGate>;
  }
  return (
    <Card
      className={cn("min-w-0 gap-0 overflow-auto py-0", fill && "h-full min-h-0")}
      style={props.height && !fill ? { height: props.height } : undefined}
      data-testid="app-file"
    >
      {body}
    </Card>
  );
}

function FileBody({ file }: { file: DrivePath }) {
  const stat = useAgentFsStat(file);
  if (stat.data) {
    const name = file.path.split("/").pop() ?? file.path;
    return (
      <>
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <FileKindIcon name={name} isFolder={false} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
          <OpenInAgentFsButton target={file} iconOnly />
          <DownloadButton file={file} iconOnly bytes={stat.data.size} />
        </div>
        <FileContent file={file} stat={stat.data} />
      </>
    );
  }
  if (isNotFound(stat.error)) {
    return (
      <EmptyState compact icon={FileQuestion} title="File not found" description={file.path} />
    );
  }
  if (isAccessDenied(stat.error)) {
    return (
      <EmptyState
        compact
        icon={Lock}
        title="You do not have access to this file"
        description={file.path}
      />
    );
  }
  if (stat.error) {
    return (
      <AlertCallout tone="error" icon={AlertCircle} title="Could not load the file">
        {stat.error.message}
      </AlertCallout>
    );
  }
  return <ViewerSkeleton />;
}

/** Comb's viewer for the file kind. HTML is a `text` kind, so it shows as source. */
function FileContent({ file, stat }: { file: DrivePath; stat: StatResult }) {
  const kind = getFileKind(file.path, stat.contentType, stat.size);
  if (kind === "markdown") {
    return (
      <TextGate file={file} stat={stat}>
        {(text) => (
          <div
            className="prose-doc min-w-0 px-4 py-3 text-foreground"
            data-testid="app-file-markdown"
          >
            <MarkdownView text={text} normalizeSoftBreaks={false} html={false} />
          </div>
        )}
      </TextGate>
    );
  }
  const Viewer = VIEWERS[kind];
  return (
    <Suspense fallback={<ViewerSkeleton />}>
      <Viewer file={file} stat={stat} />
    </Suspense>
  );
}
