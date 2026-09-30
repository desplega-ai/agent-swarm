import { Send, UserRound } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { pickableMembers, useAgentFsAccess, useDriveMembers } from "@/api/hooks/use-agent-fs";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { caretClientRect } from "@/lib/comb/caret-position";
import {
  activeMentionQuery,
  collectMentionIds,
  insertMention,
  type LabeledMember,
  labelMembers,
  SWARM_LABEL,
} from "@/lib/comb/mentions";
import type { ComposerExtrasContext } from "./comment-composer";
import { useCommentContext } from "./comment-context";

interface PickerItem {
  /** cmdk item value. */
  value: string;
  /** Inserted as `@<label>`. */
  label: string;
  detail: string;
  kind: "swarm" | "member";
}

/** The swarm entry first, then the members whose label or email contains the query. */
function pickerItems(members: readonly LabeledMember[], query: string): PickerItem[] {
  const q = query.toLowerCase();
  const items: PickerItem[] = [];
  if (SWARM_LABEL.includes(q)) {
    items.push({ value: "swarm", label: SWARM_LABEL, detail: "Send to the swarm", kind: "swarm" });
  }
  for (const { member, label } of members) {
    if (label.toLowerCase().includes(q) || member.email.toLowerCase().includes(q)) {
      items.push({ value: `member:${member.userId}`, label, detail: member.email, kind: "member" });
    }
  }
  return items;
}

/** `CommentRail`'s `renderComposerExtras`: the mention picker in every composer. */
export function renderMentionPicker(ctx: ComposerExtrasContext) {
  return <MentionPicker {...ctx} />;
}

/**
 * "@" in a comment composer opens a list at the caret: "swarm" (inserts the
 * `@swarm` marker) and the drive's human members. Picking a member inserts
 * `@<label>` and the send adds their user id to `mentions`. The focus stays
 * in the textarea: Up and Down move, Enter or Tab picks, Escape closes (until
 * the next "@"). With the list closed, every key goes to the textarea.
 * Renders nothing when agent-fs lacks `comment-mentions` or `drive-members`.
 */
function MentionPicker({ textareaRef, body, setBody, sendParamsRef }: ComposerExtrasContext) {
  const { file } = useCommentContext();
  const { features } = useAgentFs();
  const { userId } = useAgentFsAccess();
  const enabled = features.has("comment-mentions") && features.has("drive-members");
  const members = useDriveMembers(file).data?.members;
  // Step-9 merge: pass `status.agent_fs.comb.service_user_id` as the third argument.
  const labeled = useMemo(
    () => labelMembers(pickableMembers(members ?? [], userId)),
    [members, userId],
  );

  // Every member label still written in the body is a mention (a pick, a
  // typed name, or a restored draft), so the ids also reach the outbox.
  useEffect(() => {
    if (!enabled) return;
    const labels = new Map(labeled.map(({ member, label }) => [label, member.userId]));
    sendParamsRef.current = (text) => {
      const mentions = collectMentionIds(text, labels);
      return mentions.length > 0 ? { mentions } : {};
    };
    return () => {
      sendParamsRef.current = null;
    };
  }, [enabled, labeled, sendParamsRef]);

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
    const next = insertMention(body, match, item.label);
    setBody(next.text, next.caret);
    setCaret(next.caret);
    textareaRef.current?.focus();
  };
  const dismiss = () => setDismissedAt(matchStart);

  // Keys go to the list only while it is open. The listener runs on the
  // textarea before the composer's own handler, which skips prevented events.
  const latest = useRef({ open, items, active, pick, dismiss });
  latest.current = { open, items, active, pick, dismiss };
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!enabled || !textarea) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const state = latest.current;
      if (!state.open || event.defaultPrevented || event.isComposing) return;
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
        case "Escape":
          state.dismiss();
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
  // leaves the textarea). cmdk sets the option ids, so read them after it renders.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!enabled || !textarea) return;
    textarea.setAttribute("aria-autocomplete", "list");
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

  // The list opens under the "@", so it stays put while the query grows.
  const anchorAt = useRef(0);
  anchorAt.current = matchStart ?? 0;
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
        if (!next) dismiss();
      }}
    >
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        hideWhenDetached
        className="w-72 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
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
                {item.kind === "swarm" ? <Send /> : <UserRound />}
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
