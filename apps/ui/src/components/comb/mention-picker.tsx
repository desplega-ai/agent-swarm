import { Send, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentFsAccess, useDriveMembers } from "@/api/hooks/use-agent-fs";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { caretClientRect } from "@/lib/comb/caret-position";
import {
  activeMentionQuery,
  collectMentionIds,
  insertMention,
  labelMembers,
  type PickerItem,
  pickableMembers,
  pickerItems,
} from "@/lib/comb/mentions";
import type { ComposerExtrasContext } from "./comment-composer";
import { useCommentContext } from "./comment-context";
import { useCombServiceUserId } from "./use-comb-service-user";

/** The textarea's list attributes, removed when the picker turns off or unmounts. */
const LIST_ATTRIBUTES = ["aria-autocomplete", "aria-controls", "aria-activedescendant"] as const;

/**
 * True while an IME composes text (same rule as `lib/enter-submit.ts`).
 * Safari sends the key that ends a composition with `isComposing` false and
 * keyCode 229.
 */
function isImeKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** `CommentRail`'s `renderComposerExtras`: the mention picker in every composer. */
export function renderMentionPicker(ctx: ComposerExtrasContext) {
  return <MentionPicker {...ctx} />;
}

/**
 * "@" in a comment composer opens a list at the caret: "swarm" (inserts the
 * `@swarm` marker) and the drive's human members. Picking a member inserts
 * `@<label>` and records the pick: the send adds the user ids of the picked
 * labels still in the text to `mentions`. A typed name notifies nobody. The
 * focus stays in the textarea: Up and Down move, Enter or Tab picks, Escape
 * closes (until the next "@"). With the list closed, every key goes to the
 * textarea. Renders nothing when agent-fs lacks `comment-mentions` or
 * `drive-members`.
 */
function MentionPicker({
  textareaRef,
  body,
  setBody,
  picked,
  sendParamsRef,
}: ComposerExtrasContext) {
  const { file } = useCommentContext();
  const { features } = useAgentFs();
  const { userId } = useAgentFsAccess();
  const enabled = features.has("comment-mentions") && features.has("drive-members");
  const members = useDriveMembers(file).data?.members;
  // The swarm service account posts the "sent" replies. Nobody mentions it.
  const serviceUserId = useCombServiceUserId();
  const labeled = useMemo(
    () => labelMembers(pickableMembers(members ?? [], userId, serviceUserId)),
    [members, userId, serviceUserId],
  );

  // Only picked labels still in the text are mentions. The ids also reach
  // the outbox entry, because they go into the `comment-add` params.
  useEffect(() => {
    if (!enabled) return;
    sendParamsRef.current = (text) => {
      const mentions = collectMentionIds(text, picked);
      return mentions.length > 0 ? { mentions } : {};
    };
    return () => {
      sendParamsRef.current = null;
    };
  }, [enabled, picked, sendParamsRef]);

  // The caret while the textarea has focus and no text is selected.
  const [caret, setCaret] = useState<number | null>(null);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!enabled || !textarea) return;
    const update = () => {
      const focused = textarea.ownerDocument.activeElement === textarea;
      const collapsed = textarea.selectionStart === textarea.selectionEnd;
      setCaret(focused && collapsed ? textarea.selectionStart : null);
    };
    const events = ["input", "keyup", "click", "focus", "blur", "select"] as const;
    for (const type of events) textarea.addEventListener(type, update);
    textarea.ownerDocument.addEventListener("selectionchange", update);
    update();
    return () => {
      for (const type of events) textarea.removeEventListener(type, update);
      textarea.ownerDocument.removeEventListener("selectionchange", update);
    };
  }, [enabled, textareaRef]);

  const match = caret === null ? null : activeMentionQuery(body, caret);
  const matchStart = match?.start ?? null;
  const query = match?.query ?? null;
  const items = useMemo(
    () => (query === null ? [] : pickerItems(labeled, query)),
    [labeled, query],
  );

  // Escape closes the list for this "@". A new "@" opens it again.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  useEffect(() => {
    if (matchStart === null) setDismissedAt(null);
  }, [matchStart]);

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    // A new query starts at the top of the list.
    if (query !== null) setActiveIndex(0);
  }, [query]);
  const active = Math.min(activeIndex, items.length - 1);
  const open = enabled && matchStart !== null && matchStart !== dismissedAt && items.length > 0;

  const pick = (item: PickerItem) => {
    if (!match) return;
    // Record the pick before `setBody`, so the draft save includes it.
    if (item.userId !== null) picked.set(item.label, item.userId);
    const next = insertMention(body, match, item.label);
    setBody(next.text, next.caret);
    setCaret(next.caret);
    textareaRef.current?.focus();
  };

  // Keys go to the list only while it is open. The listener runs on the
  // textarea before the composer's own handler, which skips prevented events.
  // Escape never gets here: the popover's dismiss layer handles it first.
  const latest = useRef({ open, items, active, pick });
  latest.current = { open, items, active, pick };
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!enabled || !textarea) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const state = latest.current;
      if (!state.open || event.defaultPrevented || isImeKey(event)) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const count = state.items.length;
      switch (event.key) {
        case "ArrowDown":
          setActiveIndex((state.active + 1) % count);
          break;
        case "ArrowUp":
          setActiveIndex((state.active - 1 + count) % count);
          break;
        case "Enter":
        case "Tab":
          if (event.shiftKey) return;
          state.pick(state.items[state.active]);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    textarea.addEventListener("keydown", onKeyDown);
    return () => textarea.removeEventListener("keydown", onKeyDown);
  }, [enabled, textareaRef]);

  // The textarea points at the list and its active option (the focus never
  // leaves the textarea).
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!enabled || !textarea) return;
    textarea.setAttribute("aria-autocomplete", "list");
    return () => {
      for (const name of LIST_ATTRIBUTES) textarea.removeAttribute(name);
    };
  }, [enabled, textareaRef]);
  // cmdk sets the option ids, so read them after it renders.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!enabled || !textarea) return;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const option = list?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]');
      option?.scrollIntoView({ block: "nearest" });
      if (open && list?.id) textarea.setAttribute("aria-controls", list.id);
      else textarea.removeAttribute("aria-controls");
      if (open && option?.id) textarea.setAttribute("aria-activedescendant", option.id);
      else textarea.removeAttribute("aria-activedescendant");
    });
    return () => cancelAnimationFrame(frame);
  });

  // The list opens under the "@", so it stays put while the query grows. It
  // keeps the last "@" while it closes.
  const anchorAt = useRef(0);
  const anchorStart = matchStart ?? anchorAt.current;
  anchorAt.current = anchorStart;
  const virtualRef = useRef({
    getBoundingClientRect: () =>
      textareaRef.current ? caretClientRect(textareaRef.current, anchorAt.current) : new DOMRect(),
    get contextElement() {
      return textareaRef.current ?? undefined;
    },
  });

  if (!enabled) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissedAt(matchStart);
      }}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        // A new "@" places a new list (the virtual anchor moved).
        key={anchorStart}
        side="bottom"
        align="start"
        sideOffset={4}
        hideWhenDetached
        // Opened by typing: no open or close motion (apps/ui/CLAUDE.md, Motion).
        className="w-72 p-1 animate-none!"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Escape that cancels an IME composition keeps the list open.
          if (isImeKey(event)) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          // A click in the textarea moves the caret. The list follows it.
          if (event.target === textareaRef.current) event.preventDefault();
        }}
        // A click on an option keeps the focus (and the caret) in the textarea.
        onMouseDown={(event) => event.preventDefault()}
      >
        <Command
          shouldFilter={false}
          value={items[active]?.value ?? ""}
          onValueChange={(value) => {
            const index = items.findIndex((item) => item.value === value);
            if (index >= 0) setActiveIndex(index);
          }}
        >
          <CommandList ref={listRef} label="Mention suggestions">
            {items.map((item) => (
              <CommandItem key={item.value} value={item.value} onSelect={() => pick(item)}>
                {item.userId === null ? <Send /> : <UserRound />}
                <span className="max-w-[60%] shrink-0 truncate font-medium">{item.label}</span>
                <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
                  {item.detail}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
