/**
 * Form `kind: "file"` fields: pick local files to upload on submit, or attach
 * a file that already exists in agent-fs. Both go through the VIEWER's own
 * agent-fs key on the swarm's default drive, like `Files` and `File`.
 */

import { useQueryClient } from "@tanstack/react-query";
import { FolderSearch, Paperclip, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { FileKindIcon } from "@/components/comb/file-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { agentFsKey } from "@/lib/agent-fs/query";
import { formatBytes } from "@/lib/format-bytes";
import type { FormField } from "./catalog";
import { AgentFsGate, FilesView } from "./files";
import { allowsPick, allowsUpload, type UploadFn } from "./form-file-model";

const UPLOAD_MESSAGE = "Attached from an app form";

/**
 * Create-only upload into the swarm drive with the viewer's key. A landed
 * file refreshes the drive's folder listings, so a `Files` on the page shows
 * it. Null while agent-fs is not connected.
 */
export function useFormFileUploader(): UploadFn | null {
  const agentFs = useOptionalAgentFs();
  const queryClient = useQueryClient();
  const ready =
    agentFs?.state === "ready" && agentFs.client && agentFs.orgId && agentFs.driveId
      ? agentFs
      : null;
  const upload = useCallback<UploadFn>(
    async (path, file) => {
      if (!ready?.client || !ready.orgId || !ready.driveId) {
        throw new Error("agent-fs is not connected");
      }
      const { orgId, driveId } = ready;
      await ready.client.putRaw(orgId, driveId, path, file, {
        ifNoneMatch: true,
        message: UPLOAD_MESSAGE,
      });
      void queryClient.invalidateQueries({
        queryKey: agentFsKey(
          ready.endpoint ?? "",
          ready.credential?.userId ?? null,
          orgId,
          driveId,
          "ls",
        ),
      });
      return path;
    },
    [ready, queryClient],
  );
  return ready ? upload : null;
}

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * The field body. `paths` are attached agent-fs files (the state value),
 * `files` local files that upload on submit. Without a connection the
 * gate shows the "Connect agent-fs" card instead.
 */
export function FormFileField({
  field,
  inputId,
  paths,
  files,
  onChange,
}: {
  field: FormField;
  inputId: string;
  paths: readonly string[];
  files: readonly File[];
  onChange: (next: { paths: string[]; files: File[] }) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const multiple = field.multiple === true;
  const empty = paths.length === 0 && files.length === 0;

  const addFiles = (added: File[]) => {
    if (added.length === 0) return;
    onChange(
      multiple
        ? { paths: [...paths], files: [...files, ...added] }
        : { paths: [], files: added.slice(0, 1) },
    );
  };
  const addPath = (path: string) => {
    onChange(
      multiple
        ? { paths: paths.includes(path) ? [...paths] : [...paths, path], files: [...files] }
        : { paths: [path], files: [] },
    );
  };

  return (
    <AgentFsGate>
      {() => (
        <div className="flex flex-col gap-2" data-testid="json-render-form-file">
          {empty ? null : (
            <ul className="flex flex-col divide-y rounded-md border">
              {paths.map((path) => (
                <li
                  key={`p:${path}`}
                  className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm"
                >
                  <FileKindIcon name={path} isFolder={false} />
                  <span className="min-w-0 flex-1 truncate" title={path}>
                    {baseName(path)}
                  </span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${baseName(path)}`}
                    onClick={() =>
                      onChange({ paths: paths.filter((p) => p !== path), files: [...files] })
                    }
                  >
                    <X />
                  </Button>
                </li>
              ))}
              {files.map((file, index) => (
                <li
                  key={`f:${index}:${file.name}`}
                  className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-sm"
                >
                  <FileKindIcon name={file.name} isFolder={false} />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatBytes(file.size)} · uploads on submit
                  </span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      onChange({ paths: [...paths], files: files.filter((_, i) => i !== index) })
                    }
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {allowsUpload(field) ? (
              <>
                <input
                  ref={inputRef}
                  id={inputId}
                  type="file"
                  hidden
                  multiple={multiple}
                  accept={field.accept?.join(",")}
                  data-testid="json-render-form-file-input"
                  onChange={(event) => {
                    const picked = Array.from(event.currentTarget.files ?? []);
                    // Reset, so choosing the same file again fires a change.
                    event.currentTarget.value = "";
                    addFiles(picked);
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => inputRef.current?.click()}
                >
                  <Paperclip />
                  {empty || multiple ? "Choose file" : "Replace file"}
                </Button>
              </>
            ) : null}
            {allowsPick(field) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                id={allowsUpload(field) ? undefined : inputId}
                onClick={() => setPicking(true)}
              >
                <FolderSearch />
                Pick from agent-fs
              </Button>
            ) : null}
          </div>
          <Dialog open={picking} onOpenChange={setPicking}>
            <DialogContent className="sm:max-w-lg">
              <DialogTitle>Pick a file</DialogTitle>
              <FilesView
                props={{ path: field.dir ?? "/", mode: "browser", maxHeight: "360px" }}
                onSelect={(row) => {
                  if (row.type !== "file") return;
                  addPath(row.path);
                  setPicking(false);
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      )}
    </AgentFsGate>
  );
}
