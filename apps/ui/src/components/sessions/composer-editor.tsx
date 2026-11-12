/**
 * `ComposerDock`'s text box: a Tiptap editor, loaded as its own chunk. It
 * keeps the dock's plain string contract (`value` / `onChange`): lines are
 * paragraphs, and an `@` or `/` pick is a chip that one Backspace deletes and
 * that is sent as a markdown link (`lib/composer-mentions.ts`).
 *
 * Keys follow `lib/enter-submit.ts`, as the textarea did. A paste inserts
 * plain text only, after the smart-paste rules (`lib/composer-paste.ts`).
 */

import Document from "@tiptap/extension-document";
import Mention from "@tiptap/extension-mention";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { splitBlock } from "@tiptap/pm/commands";
import { Slice } from "@tiptap/pm/model";
import { PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import { useEffect, useRef, useState } from "react";
import {
  MentionMenu,
  type MentionMenuState,
  MentionPrefetch,
} from "@/components/sessions/mention-menu";
import {
  composerDocToText,
  composerTextToDoc,
  type MentionChar,
  mentionMarkdown,
} from "@/lib/composer-mentions";
import { linkOverSelection, pastedUrl, tsvToMarkdownTable } from "@/lib/composer-paste";
import { isCoarsePointerInput, shouldSubmitOnEnterKeyDown } from "@/lib/enter-submit";
import { cn } from "@/lib/utils";

export interface ComposerEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter (or Cmd/Ctrl+Enter) asked to send. */
  onSubmitKey: () => void;
  /** Pasted files. True when they were taken. */
  onPasteFiles: (files: File[]) => boolean;
  /** Pasted text long enough to be a file. True when it was attached instead. */
  onPasteLongText: (text: string) => boolean;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

/** Inserts plain text at the selection: one paragraph per line, links as chips. */
function insertPlainText(view: EditorView, text: string) {
  const doc = view.state.schema.nodeFromJSON(composerTextToDoc(text));
  view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(doc.content)).scrollIntoView());
}

export default function ComposerEditor(props: ComposerEditorProps) {
  const { value, placeholder, ariaLabel, disabled, autoFocus, className } = props;
  const latest = useRef(props);
  latest.current = props;
  // The last text this editor sent up: a different `value` came from outside.
  const lastValue = useRef(value);
  const [menu, setMenu] = useState<MentionMenuState | null>(null);
  const menuKey = useRef<((event: KeyboardEvent) => boolean) | null>(null);
  const [focused, setFocused] = useState(false);

  const suggestion = (char: MentionChar): Omit<SuggestionOptions, "editor"> => ({
    char,
    pluginKey: new PluginKey(`composer-mention-${char}`),
    // The list searches in React (`MentionMenu`), not here.
    items: () => [],
    render: () => {
      const show = (p: SuggestionProps) =>
        setMenu({
          char,
          query: p.query,
          clientRect: p.clientRect,
          pick: ({ href, label }) => p.command({ id: href, label }),
        });
      return {
        onStart: show,
        onUpdate: show,
        onExit: () => setMenu(null),
      };
    },
  });

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      UndoRedo,
      Placeholder.configure({ placeholder: () => latest.current.placeholder ?? "" }),
      Mention.configure({
        deleteTriggerWithBackspace: true,
        HTMLAttributes: {
          class: "rounded-md bg-muted px-1.5 py-0.5 font-medium text-primary",
        },
        renderText: ({ node }) =>
          mentionMarkdown({
            char: node.attrs.mentionSuggestionChar === "/" ? "/" : "@",
            label: node.attrs.label ?? node.attrs.id,
            href: node.attrs.id,
          }),
        suggestions: [suggestion("@"), suggestion("/")],
      }),
    ],
    content: composerTextToDoc(value),
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      // A function: ProseMirror reads it on every update, so a new label applies.
      attributes: () => {
        const { ariaLabel: label = latest.current.placeholder, placeholder: hint } = latest.current;
        return {
          role: "textbox",
          "aria-multiline": "true",
          ...(label ? { "aria-label": label } : {}),
          ...(hint ? { "aria-placeholder": hint } : {}),
          ...(latest.current.disabled ? { "aria-disabled": "true" } : {}),
          class: cn(
            "w-full overflow-y-auto whitespace-pre-wrap break-words outline-none",
            // The placeholder on the empty first line (Tiptap's Placeholder).
            "[&_p.is-editor-empty:first-child]:before:pointer-events-none",
            "[&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0",
            "[&_p.is-editor-empty:first-child]:before:text-muted-foreground",
            "[&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
            latest.current.className,
          ),
        };
      },
      handleKeyDown: (view, event) => {
        // An open list with rows takes Up, Down, Enter and Tab. Escape goes
        // on to the suggestion plugin, which closes the list.
        if (menuKey.current?.(event)) return true;
        if (event.key !== "Enter") return false;
        // An IME confirming a word: neither send nor split the line.
        if (event.isComposing || event.keyCode === 229) return true;
        const submit = shouldSubmitOnEnterKeyDown(
          {
            key: event.key,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            isComposing: event.isComposing,
            keyCode: event.keyCode,
          },
          isCoarsePointerInput(),
        );
        if (submit) {
          latest.current.onSubmitKey();
          return true;
        }
        // Shift+Enter (and a soft keyboard's Return) starts a new line.
        return splitBlock(view.state, view.dispatch);
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        if (data.files.length > 0) return latest.current.onPasteFiles(Array.from(data.files));
        const text = data.getData("text/plain");
        if (!text) return false;
        if (latest.current.onPasteLongText(text)) return true;
        const { from, to, empty, $from } = view.state.selection;
        const url = pastedUrl(text);
        const table = tsvToMarkdownTable(text);
        insertPlainText(
          view,
          // A markdown table must start on its own line.
          (table && ($from.parentOffset > 0 ? `\n${table}` : table)) ??
            (url && !empty
              ? linkOverSelection(view.state.doc.textBetween(from, to, "\n"), url)
              : text),
        );
        return true;
      },
      // Dropped files go to the dock's drop handler, not into the text.
      handleDrop: (_view, event) => (event.dataTransfer?.files.length ?? 0) > 0,
    },
    onUpdate: ({ editor }) => {
      const next = composerDocToText(editor.getJSON());
      if (next === lastValue.current) return;
      lastValue.current = next;
      latest.current.onChange(next);
    },
    onFocus: () => setFocused(true),
  });

  // A new value from outside (a sent message cleared, a draft from another tab).
  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    lastValue.current = value;
    editor.commands.setContent(composerTextToDoc(value), { emitUpdate: false });
  }, [editor, value]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the attributes read these through `latest`.
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
    // An empty transaction re-reads the attributes and the placeholder.
    editor.view.dispatch(editor.state.tr);
  }, [editor, disabled, placeholder, ariaLabel, className]);

  return (
    <>
      <EditorContent editor={editor} />
      {focused ? <MentionPrefetch /> : null}
      {menu ? <MentionMenu state={menu} onKeyRef={menuKey} /> : null}
    </>
  );
}
