import { type FormEvent, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAgentFsComments } from "@/api/hooks/use-agent-fs";
import { mutationMessage, useCombMutations } from "@/api/hooks/use-comb-mutations";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { normalizeRelativePath, renameValue } from "@/lib/comb/file-names";
import { combPath, type DrivePath, parentFolder } from "@/lib/comb/paths";

// The write dialogs of the file menu (like the agent-fs live UI): New file,
// New folder, Rename, Delete. Each is mounted only while open, so every
// opening starts fresh. `current` is the path the page shows: a rename or a
// delete of it moves the page.

function Code({ children }: { children: string }) {
  return <code className="font-mono text-xs break-all">{children}</code>;
}

/** The number of comments on `file`, for the rename and delete notes. Null while unknown. */
function useCommentCount(file: DrivePath): number | null {
  const threads = useAgentFsComments(file).data?.threads;
  return threads ? threads.length : null;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** New file or New folder in `folder`. Nested names ("notes/todo.md") make the folders they need. */
export function NewEntryDialog({
  kind,
  folder,
  onClose,
}: {
  kind: "file" | "folder";
  folder: DrivePath;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const mutations = useCombMutations(folder);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const isFile = kind === "file";
  const where = folder.path === "/" ? "the drive root" : folder.path;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = normalizeRelativePath(value);
    if ("error" in name) {
      setError(name.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const path = isFile
        ? await mutations.createFile(folder.path, name.path)
        : await mutations.createFolder(folder.path, name.path);
      toast.success(isFile ? "File created" : "Folder created", { description: path });
      onClose();
      void navigate(combPath({ ...folder, path }));
    } catch (err) {
      setError(mutationMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{isFile ? "New file" : "New folder"}</DialogTitle>
            <DialogDescription>
              In <Code>{where}</Code>.{" "}
              {isFile
                ? "A name like notes/todo.md also makes the folders."
                : "An empty .keep file keeps the folder in listings."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              placeholder={isFile ? "notes/todo.md" : "reports/2026"}
              aria-label={isFile ? "File name" : "Folder name"}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              disabled={busy}
            />
            {error ? (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || value.trim() === ""}>
              {busy ? <Spinner /> : null}
              {isFile ? "Create file" : "Create folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rename or move a file: the box holds its full path. */
export function RenameDialog({
  file,
  current,
  onClose,
}: {
  file: DrivePath;
  current: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const mutations = useCombMutations(file);
  const comments = useCommentCount(file);
  const [value, setValue] = useState(() => renameValue(file.path));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = normalizeRelativePath(value);
    if ("error" in name) {
      setError(name.error);
      return;
    }
    const to = `/${name.path}`;
    if (to === file.path) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await mutations.rename(file.path, to);
      toast.success("Renamed", { description: to });
      onClose();
      if (current === file.path) void navigate(combPath({ ...file, path: to }), { replace: true });
    } catch (err) {
      setError(mutationMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>
              Edit the full path to rename or move the file. The old path keeps its history
              {comments ? ` and its ${plural(comments, "comment")}` : null}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Input
              autoFocus
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              onFocus={(event) => {
                // Select the name without its extension, like a file manager.
                const input = event.currentTarget;
                const start = input.value.lastIndexOf("/") + 1;
                const dot = input.value.lastIndexOf(".");
                input.setSelectionRange(start, dot > start ? dot : input.value.length);
              }}
              aria-label="New path"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              disabled={busy}
            />
            {error ? (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || value.trim() === ""}>
              {busy ? <Spinner /> : null}
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Delete a file. Its versions are kept, so `agent-fs revert` can bring it back. */
export function DeleteDialog({
  file,
  current,
  onClose,
}: {
  file: DrivePath;
  current: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const mutations = useCombMutations(file);
  const comments = useCommentCount(file);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await mutations.remove(file.path);
      toast.success("Deleted", { description: file.path });
      onClose();
      if (current === file.path) {
        void navigate(combPath({ ...file, path: parentFolder(file.path) }), { replace: true });
      }
    } catch (err) {
      setError(mutationMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    // An alert dialog: an outside click does not dismiss a delete.
    <AlertDialog open onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete file</AlertDialogTitle>
          <AlertDialogDescription>
            Delete <Code>{file.path}</Code>? It leaves the listings. Its versions are kept, so{" "}
            <Code>agent-fs revert</Code> can bring it back.
            {comments ? ` Its ${plural(comments, "comment")} are removed.` : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={busy}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={(event) => {
              // Stay open until agent-fs answers: an error shows here.
              event.preventDefault();
              void remove();
            }}
          >
            {busy ? <Spinner /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
