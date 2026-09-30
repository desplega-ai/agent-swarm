import { SendHorizontal } from "lucide-react";
import {
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useAddComment } from "@/api/hooks/use-agent-fs";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import type { CommentAddParams } from "@/lib/agent-fs/types";
import { commentWritePath } from "@/lib/comb/comments";
import type { NewCommentAnchor } from "@/lib/comb/dom-text-space";
import {
  anchorKeyOf,
  browserStorage,
  clearDraft,
  draftStorageKey,
  errorMessage,
  readDraft,
  sendFailureRoute,
  writeDraft,
} from "@/lib/comb/drafts";
import { useCommentContext } from "./comment-context";

/** What the composer posts: a file-level comment, an anchored one, or a reply. */
export type ComposerTarget =
  | { kind: "file" }
  | { kind: "anchor"; anchor: NewCommentAnchor }
  | { kind: "reply"; parentId: string };

/** What `renderComposerExtras` (step-8 mention picker) gets from the composer. */
export interface ComposerExtrasContext {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  body: string;
  /** Replace the text. `caret` moves the cursor after the change. */
  setBody: (body: string, caret?: number) => void;
  /** Extra `comment-add` params, read at send time (step-8: `mentions`). */
  sendParamsRef: MutableRefObject<((body: string) => Partial<CommentAddParams>) | null>;
}

const DRAFT_SAVE_DELAY_MS = 300;

/** Same words as the rail notice and the Resolve error. */
export const READ_ONLY_MESSAGE = "You have view-only access";

function draftSlot(target: ComposerTarget): string {
  if (target.kind === "reply") return target.parentId;
  if (target.kind === "anchor") return anchorKeyOf(target.anchor);
  return "file";
}

function paramsFor(target: ComposerTarget, path: string, body: string): CommentAddParams {
  if (target.kind === "reply") return { parentId: target.parentId, body };
  if (target.kind === "file") return { path: commentWritePath(path), body };
  const { quote, lineStart, lineEnd, quotedContent } = target.anchor;
  return { path: commentWritePath(path), body, quote, lineStart, lineEnd, quotedContent };
}

/** True when a saved draft exists for this composer (the rail reopens it after a reload). */
export function useHasDraft(target: ComposerTarget): boolean {
  const { scope } = useCommentContext();
  const [has] = useState(
    () => readDraft(browserStorage(), draftStorageKey(scope, draftSlot(target)), Date.now()) !== "",
  );
  return has;
}

interface CommentComposerProps {
  target: ComposerTarget;
  placeholder?: string;
  autoFocus?: boolean;
  /** After a send (posted, or kept in the outbox) and after Cancel or Escape. */
  onClose: () => void;
  /** Step-8 mounts the mention picker here. Null in step-7. */
  renderComposerExtras?: (ctx: ComposerExtrasContext) => ReactNode;
}

/**
 * Write a comment. Cmd/Ctrl+Enter sends. Escape closes and keeps the draft,
 * Cancel drops it. The text is saved as a draft while typing (7 days). A
 * network error or a 5xx moves the comment to the outbox ("Not sent" in the
 * rail). A 403 marks the rail read-only. Read-only renders nothing: the rail
 * shows the notice.
 */
export function CommentComposer({
  target,
  placeholder = "Add a comment",
  autoFocus,
  onClose,
  renderComposerExtras,
}: CommentComposerProps) {
  const { file, scope, outbox, readOnly, markReadOnly } = useCommentContext();
  const addComment = useAddComment(file);
  const draftKey = draftStorageKey(scope, draftSlot(target));
  const [body, setBodyState] = useState(() => readDraft(browserStorage(), draftKey, Date.now()));
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendParamsRef = useRef<((body: string) => Partial<CommentAddParams>) | null>(null);

  // Debounced draft save. Unmount (or a new key) flushes the pending write.
  const pendingDraft = useRef<string | null>(null);
  const scheduleDraftSave = useRef<() => void>(() => {});
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (pendingDraft.current === null) return;
      writeDraft(browserStorage(), draftKey, pendingDraft.current, Date.now());
      pendingDraft.current = null;
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(flush, DRAFT_SAVE_DELAY_MS);
    };
    scheduleDraftSave.current = schedule;
    return () => {
      clearTimeout(timer);
      flush();
    };
  }, [draftKey]);

  const setBody = useCallback((next: string, caret?: number) => {
    setBodyState(next);
    setError(null);
    pendingDraft.current = next;
    scheduleDraftSave.current();
    if (caret !== undefined) {
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(caret, caret));
    }
  }, []);

  // Sent, queued, or cancelled with the Cancel button: the draft goes. Escape
  // and a click outside close the composer and keep the draft.
  const finish = () => {
    pendingDraft.current = null;
    clearDraft(browserStorage(), draftKey);
    setBodyState("");
    onClose();
  };

  const send = async () => {
    const text = body.trim();
    if (!text || addComment.isPending) return;
    const params = {
      ...paramsFor(target, file.path, text),
      ...sendParamsRef.current?.(text),
    };
    try {
      await addComment.mutateAsync(params);
      finish();
    } catch (err) {
      switch (sendFailureRoute(err)) {
        case "read-only":
          // The draft stays: the composer unmounts or renders nothing now.
          toast.error(READ_ONLY_MESSAGE);
          markReadOnly();
          break;
        case "outbox":
          outbox.add(params, errorMessage(err));
          toast.warning("Not sent. Kept in Comments.");
          finish();
          break;
        case "inline":
          setError(errorMessage(err));
          break;
      }
    }
  };

  if (readOnly) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={2}
          aria-label={placeholder}
          aria-invalid={error ? true : undefined}
          className="max-h-60 min-h-16 text-sm"
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        {/* Composer extras mount point (step-8 mention picker). */}
        {renderComposerExtras?.({ textareaRef, body, setBody, sendParamsRef })}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-status-error-strong">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={finish}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void send()}
          disabled={!body.trim() || addComment.isPending}
          aria-keyshortcuts="Meta+Enter Control+Enter"
        >
          <SendHorizontal />
          Send
          <Kbd tone="inverted" aria-hidden className="hidden sm:inline-flex">
            ⌘⏎
          </Kbd>
        </Button>
      </div>
    </div>
  );
}
