import { useCallback, useEffect, useRef, useState } from "react";

/** Keep the displayed definition stable until the viewer accepts a new one. */
export function useVersionedValue<T>(
  id: string | undefined,
  value: T | undefined,
  revision: string | undefined,
  autoReload: boolean,
) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const [interactedId, setInteractedId] = useState<string>();
  const markInteraction = useCallback(
    (event: { target: EventTarget | null; type: string }) => {
      const target = event.target;
      if (!id || !(target instanceof HTMLElement)) return;
      const isFrame = target.tagName === "IFRAME" && event.type === "focusin";
      const isDraft =
        event.type === "input" &&
        target.matches("input:not([type=password]), textarea, select, [contenteditable=true]");
      const isClick = event.type === "click" && !!target.closest("button, a, [role=button]");
      if (isFrame || isDraft || isClick) setInteractedId(id);
    },
    [id],
  );
  useEffect(() => {
    const onDocumentInteraction = (event: Event) => {
      const target = event.target;
      if (!id || !(target instanceof HTMLElement) || !scopeRef.current?.contains(target)) return;
      markInteraction(event);
    };
    document.addEventListener("focusin", onDocumentInteraction);
    document.addEventListener("input", onDocumentInteraction);
    return () => {
      document.removeEventListener("focusin", onDocumentInteraction);
      document.removeEventListener("input", onDocumentInteraction);
    };
  }, [id, markInteraction]);
  const [displayed, setDisplayed] = useState<{ id: string; revision: string; value: T }>();
  useEffect(() => {
    if (!id || value === undefined || revision === undefined) return;
    setDisplayed((current) => {
      if (
        !current ||
        current.id !== id ||
        (autoReload && interactedId !== id && current.revision !== revision)
      ) {
        return { id, revision, value };
      }
      return current;
    });
  }, [id, value, revision, autoReload, interactedId]);
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
    canAutoReload: interactedId !== id,
    markInteraction,
    apply,
  };
}
