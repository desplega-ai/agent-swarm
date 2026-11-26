// Approval drafts: the answers a person has picked or typed into a pending
// approval request, kept in this browser's localStorage so a reload, a crash
// or a closed tab does not lose them. Comb's drafts (`lib/comb/drafts.ts`) own
// the storage format, the try/catch and the 7-day expiry.
//
// - Keyed by request id plus a hash of the questions, namespaced by the swarm
//   API URL: a changed question set never restores a stale draft.
// - Saved 300 ms after the last change, and flushed on unmount or page hide.
// - Cleared after a successful submit and once the request is not pending.
// - Config answers are never stored: one may hold a secret value.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ApprovalQuestion, ApprovalRequest } from "../api/types";
import { deriveStorageKey } from "../hooks/use-dismissible-card-key";
import { browserStorage, clearDraft, hashText, readDraft, writeDraft } from "./comb/drafts";
import { getConfig } from "./config";

export const APPROVAL_DRAFT_SAVE_DELAY_MS = 300;

type Values = Record<string, unknown>;
type KeyedStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function draftPrefix(apiUrl: string, requestId: string): string {
  return deriveStorageKey(apiUrl, `approval:draft:${requestId}:`);
}

/** The storage key of one request's draft for this exact question set. */
export function approvalDraftKey(
  apiUrl: string,
  requestId: string,
  questions: ApprovalQuestion[],
): string {
  return `${draftPrefix(apiUrl, requestId)}${hashText(JSON.stringify(questions))}`;
}

/** The answers worth keeping: known, non-config questions only. */
function draftable(questions: ApprovalQuestion[], values: Values): Values {
  const kept: Values = {};
  for (const question of questions) {
    if (question.type !== "config" && values[question.id] !== undefined) {
      kept[question.id] = values[question.id];
    }
  }
  return kept;
}

/** The saved answers, or {}. An expired or unreadable draft reads as {}. */
export function readApprovalDraft(
  storage: KeyedStorage | null,
  key: string,
  questions: ApprovalQuestion[],
  now: number,
): Values {
  const text = readDraft(storage, key, now);
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return draftable(questions, value as Values);
  } catch {
    return {};
  }
}

/** Save the answers. No answer worth keeping removes the draft. */
export function writeApprovalDraft(
  storage: KeyedStorage | null,
  key: string,
  questions: ApprovalQuestion[],
  values: Values,
  now: number,
): void {
  const kept = draftable(questions, values);
  writeDraft(storage, key, Object.keys(kept).length > 0 ? JSON.stringify(kept) : "", now);
}

/** Remove every draft of one request, under any question set. */
export function clearApprovalDrafts(
  storage: KeyedStorage | null,
  apiUrl: string,
  requestId: string,
): void {
  if (!storage) return;
  const prefix = draftPrefix(apiUrl, requestId);
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) clearDraft(storage, key);
  } catch {
    // A blocked localStorage has nothing to clear.
  }
}

/**
 * The draft of one approval request: `initial` (the saved answers, read once
 * per question set while the request is pending), `save` (debounced) and
 * `clear` (after a successful submit). A request that leaves `pending`
 * drops its drafts. Without a request it does nothing.
 */
export function useApprovalDraft(
  request: Pick<ApprovalRequest, "id" | "questions" | "status"> | undefined,
): { initial: Values; save: (values: Values) => void; clear: () => void } {
  const apiUrl = getConfig().apiUrl;
  const requestId = request?.id;
  const questions = request?.questions;
  const pending = request?.status === "pending";
  const key = requestId && questions ? approvalDraftKey(apiUrl, requestId, questions) : null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsaved = useRef<(() => void) | null>(null);

  // Read once per key: polling refetches keep the same key, so they never reset the form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on `key` on purpose.
  const initial = useMemo<Values>(
    () =>
      key && questions && pending
        ? readApprovalDraft(browserStorage(), key, questions, Date.now())
        : {},
    [key],
  );

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const write = unsaved.current;
    unsaved.current = null;
    write?.();
  }, []);

  const save = useCallback(
    (values: Values) => {
      if (!key || !questions) return;
      if (timer.current) clearTimeout(timer.current);
      unsaved.current = () =>
        writeApprovalDraft(browserStorage(), key, questions, values, Date.now());
      timer.current = setTimeout(flush, APPROVAL_DRAFT_SAVE_DELAY_MS);
    },
    [key, questions, flush],
  );

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    unsaved.current = null;
    if (requestId) clearApprovalDrafts(browserStorage(), apiUrl, requestId);
  }, [apiUrl, requestId]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  // Resolved, expired or cancelled: nothing left to answer.
  useEffect(() => {
    if (requestId && request?.status && !pending) clear();
  }, [requestId, request?.status, pending, clear]);

  return { initial, save, clear };
}
