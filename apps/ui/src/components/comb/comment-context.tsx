import { createContext, type ReactNode, useContext } from "react";
import type { CommentScope } from "@/lib/comb/drafts";
import type { DrivePath } from "@/lib/comb/paths";
import type { ComposerExtrasContext } from "./comment-composer";
import type { CommentOutbox } from "./use-comment-outbox";

/** What every comment composer and thread card of one file shares. */
export interface CommentContextValue {
  file: DrivePath;
  /** Where drafts and the outbox are stored for this file. */
  scope: CommentScope;
  outbox: CommentOutbox;
  /** agent-fs answered 403 on a comment write: the human is a drive viewer. */
  readOnly: boolean;
  markReadOnly: () => void;
  /** Step-8 mounts the mention picker here (every composer gets it). */
  renderComposerExtras?: (ctx: ComposerExtrasContext) => ReactNode;
}

const CommentContext = createContext<CommentContextValue | null>(null);

export const CommentContextProvider = CommentContext.Provider;

export function useCommentContext(): CommentContextValue {
  const value = useContext(CommentContext);
  if (!value) throw new Error("useCommentContext must be used inside CommentRail");
  return value;
}
