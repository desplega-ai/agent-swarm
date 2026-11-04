import { useCallback, useEffect, useRef, useState } from "react";

const EDITABLE = "input:not([type=password]), textarea, select, [contenteditable=true]";

export interface VersionedValueOptions {
  /** A draft the caller tracks, such as unsaved form state. Blocks loading. */
  draft?: boolean;
  /** Called when auto reload applies a new revision. */
  onAutoApply?: () => void;
}

/** Keep the displayed definition stable until the viewer accepts a new one. */
export function useVersionedValue<T>(
  id: string | undefined,
  value: T | undefined,
  revision: string | undefined,
  autoReload: boolean,
  options: VersionedValueOptions = {},
) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const [interactedId, setInteractedId] = useState<string>();
  const [focusedDraft, setFocusedDraft] = useState(false);
  const onAutoApplyRef = useRef(options.onAutoApply);
  onAutoApplyRef.current = options.onAutoApply;
  const markInteraction = useCallback(
    (event: { target: EventTarget | null; type: string }) => {
      const target = event.target;
      if (!id || !(target instanceof HTMLElement)) return;
      const isFrame = target.tagName === "IFRAME" && event.type === "focusin";
      const isDraft = event.type === "input" && target.matches(EDITABLE);
      const isClick = event.type === "click" && !!target.closest("button, a, [role=button]");
      if (isFrame || isDraft || isClick) setInteractedId(id);
    },
    [id],
  );
  useEffect(() => {
    const inScope = (target: EventTarget | null): target is HTMLElement =>
      target instanceof HTMLElement && !!scopeRef.current?.contains(target);
    const onDocumentInteraction = (event: Event) => {
      if (!id || !inScope(event.target)) return;
      markInteraction(event);
    };
    // Focus in a field of this view counts as editing until it leaves.
    const onFocusIn = (event: Event) => {
      if (inScope(event.target) && event.target.matches(EDITABLE)) setFocusedDraft(true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (!inScope(next) || !next.matches(EDITABLE)) setFocusedDraft(false);
    };
    document.addEventListener("focusin", onDocumentInteraction);
    document.addEventListener("input", onDocumentInteraction);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onDocumentInteraction);
      document.removeEventListener("input", onDocumentInteraction);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [id, markInteraction]);
  const editing = !!options.draft || focusedDraft;
  const canAutoReload = interactedId !== id && !editing;
  const [displayed, setDisplayed] = useState<{ id: string; revision: string; value: T }>();
  useEffect(() => {
    if (!id || value === undefined || revision === undefined) return;
    if (!displayed || displayed.id !== id) {
      setDisplayed({ id, revision, value });
    } else if (autoReload && canAutoReload && displayed.revision !== revision) {
      setDisplayed({ id, revision, value });
      onAutoApplyRef.current?.();
    }
  }, [id, value, revision, autoReload, canAutoReload, displayed]);
  const apply = useCallback(() => {
    if (id && value !== undefined && revision !== undefined) {
      setDisplayed({ id, revision, value });
      setInteractedId(undefined);
    }
  }, [id, value, revision]);
  const current = displayed?.id === id ? displayed : undefined;
  return {
    scopeRef,
    value: current?.value ?? value,
    pending: !!current && revision !== undefined && current.revision !== revision,
    editing,
    canAutoReload,
    markInteraction,
    apply,
  };
}
