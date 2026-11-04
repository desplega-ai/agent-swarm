import { ListTodo, MoreHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useChecklist, useChecklistMutation } from "@/api/hooks/use-checklist";
import { isOnboardingOpen, useOnboarding } from "@/api/hooks/use-onboarding";
import type {
  ChecklistAddRequest,
  ChecklistItem,
  ChecklistResponse,
  ChecklistUpdateRequest,
} from "@/api/types";
import { StatusIcon } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

/**
 * The post-onboarding checklist on Home ("Get the swarm working"). It takes
 * over from `SetupChecklistCard` once `/setup` is finished or dismissed, and
 * shows for every non-admin at once (they never see the setup card). Items
 * check themselves from server signals; editing goes through the API, which
 * enforces who may change what (`editable` per item).
 *
 * Self-contained so the Home command center can mount it in its widget grid.
 */
export function PostOnboardingChecklistCard({ className }: { className?: string }) {
  const { data: onboarding, isPending: onboardingPending } = useOnboarding();
  const canSetup = useCan("config.write.any");
  // An admin with setup still open sees the setup card in this slot instead.
  const setupOpen = canSetup && isOnboardingOpen(onboarding);
  const waiting = canSetup && onboardingPending;
  const { data, isError } = useChecklist({ enabled: !setupOpen && !waiting });
  const mutation = useChecklistMutation();

  if (setupOpen || waiting || isError || !data) return null;

  async function run(input: Parameters<typeof mutation.mutateAsync>[0]) {
    try {
      await mutation.mutateAsync(input);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the checklist");
    }
  }

  return (
    <PostOnboardingChecklistView
      data={data}
      busy={mutation.isPending}
      className={className}
      onAdd={(body) => run({ type: "add", body })}
      onUpdate={(id, body) => run({ type: "update", id, body })}
    />
  );
}

const CHANNEL_ADAPTERS = [
  { id: "slack", name: "Slack" },
  { id: "telegram", name: "Telegram" },
  { id: "discord", name: "Discord" },
] as const;

/** The second line of an open row: why the item matters. */
function itemHint(item: ChecklistItem): string | null {
  if (item.kind === "channel" && !item.meta?.adapter) {
    return "Slack, Telegram or Discord, so people reach the swarm where they talk.";
  }
  if (item.kind === "tool") return "GitHub, Linear, Jira or Gmail, so agents act where you work.";
  if (item.kind === "use_case") {
    return "Ask the Lead to plan a recurring job, with a schedule and a home for its outputs.";
  }
  return null;
}

/** The right-side note of a done row: a signal, or who checked it by hand. */
function doneNote(item: ChecklistItem): string {
  if (item.status === "done") {
    return item.statusChangedByName ? `Marked done by ${item.statusChangedByName}` : "Marked done";
  }
  return item.kind === "use_case" ? "Done" : "Connected";
}

function removedNote(item: ChecklistItem): string {
  const who = item.statusChangedByName ? `Removed by ${item.statusChangedByName}` : "Removed";
  return item.statusReason ? `${who}: ${item.statusReason}` : who;
}

export interface PostOnboardingChecklistViewProps {
  data: ChecklistResponse;
  busy?: boolean;
  className?: string;
  onAdd: (body: ChecklistAddRequest) => void | Promise<void>;
  onUpdate: (id: string, body: ChecklistUpdateRequest) => void | Promise<void>;
}

export function PostOnboardingChecklistView({
  data,
  busy = false,
  className,
  onAdd,
  onUpdate,
}: PostOnboardingChecklistViewProps) {
  const [expanded, setExpanded] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [removing, setRemoving] = useState<ChecklistItem | null>(null);
  const titleId = useId();

  const visible = data.items.filter((item) => item.status !== "removed");
  const removed = data.items.filter((item) => item.status === "removed");
  const doneCount = visible.filter((item) => item.done).length;
  const allDone = doneCount === visible.length;
  const collapsed = allDone && !expanded;
  const count = `${doneCount} of ${visible.length}`;

  const addChannel = (adapter: (typeof CHANNEL_ADAPTERS)[number]) =>
    onAdd({
      kind: "channel",
      scope: "swarm",
      label: `Connect ${adapter.name}`,
      href: "/integrations/channels",
      meta: { adapter: adapter.id },
    });

  return (
    <section
      aria-labelledby={titleId}
      className={cn("overflow-hidden rounded-xl border border-border bg-card shadow-sm", className)}
    >
      <header className="flex h-11 items-center gap-2 px-4">
        {allDone ? (
          <StatusIcon tone="success" focusable={false} />
        ) : (
          <ListTodo className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">
          {allDone ? "Setup complete" : "Get the swarm working"}
        </h2>
        <span className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
        {allDone ? null : (
          <Progress
            value={visible.length ? (doneCount / visible.length) * 100 : 0}
            aria-label={`${count} done`}
            className="h-1 w-10 shrink-0 bg-muted [&_[data-slot=progress-indicator]]:bg-status-success"
          />
        )}
        {allDone ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Hide" : "Show"}
          </Button>
        ) : null}
      </header>

      {collapsed ? null : (
        <ul className="divide-y divide-border-subtle border-t border-border-subtle">
          {visible.map((item) => (
            <ChecklistRow
              key={item.id}
              item={item}
              busy={busy}
              canAddChannel={data.canEditSwarm && item.kind === "channel"}
              onRemove={() => setRemoving(item)}
              onUpdate={(body) => onUpdate(item.id, body)}
              onAddChannel={addChannel}
            />
          ))}
        </ul>
      )}

      {removed.length > 0 && !collapsed ? (
        <div className="border-t border-border-subtle">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="mx-2 my-1.5 text-muted-foreground"
            aria-expanded={showRemoved}
            onClick={() => setShowRemoved((open) => !open)}
          >
            {showRemoved ? "Hide removed" : `Show removed (${removed.length})`}
          </Button>
          {showRemoved ? (
            <ul className="divide-y divide-border-subtle border-t border-border-subtle">
              {removed.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-muted-foreground">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{removedNote(item)}</p>
                  </div>
                  {item.editable ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void onUpdate(item.id, { action: "restore" })}
                    >
                      Restore
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <RemoveDialog
        item={removing}
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={async (reason) => {
          const item = removing;
          setRemoving(null);
          if (item) await onUpdate(item.id, { action: "remove", ...(reason ? { reason } : {}) });
        }}
      />
    </section>
  );
}

function ChecklistRow({
  item,
  busy,
  canAddChannel,
  onRemove,
  onUpdate,
  onAddChannel,
}: {
  item: ChecklistItem;
  busy: boolean;
  canAddChannel: boolean;
  onRemove: () => void;
  onUpdate: (body: ChecklistUpdateRequest) => void | Promise<void>;
  onAddChannel: (adapter: (typeof CHANNEL_ADAPTERS)[number]) => void | Promise<void>;
}) {
  const hint = item.done ? null : itemHint(item);
  // A swarm item a member cannot change has no action for them: Connect pages are admin only.
  const action = !item.done && item.href && item.editable ? item.href : null;
  const hasMenu = item.editable || canAddChannel;

  return (
    <li className={cn("flex gap-3 px-4", item.done ? "items-center py-2.5" : "items-start py-3")}>
      {item.done ? (
        <StatusIcon tone="success" label={doneNote(item)} />
      ) : (
        <span
          role="img"
          aria-label="Not done"
          className="mt-0.5 size-4 shrink-0 rounded-full border-2 border-border"
        />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm leading-snug",
            item.done ? "text-muted-foreground" : "font-medium",
          )}
        >
          {item.label}
        </p>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {item.done ? (
        <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
          {doneNote(item)}
        </span>
      ) : null}
      {action ? (
        <Button asChild size="xs" variant="outline" className="shrink-0">
          <Link to={action}>{item.kind === "use_case" ? "Start" : "Open"}</Link>
        </Button>
      ) : null}
      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              disabled={busy}
              aria-label={`More actions for ${item.label}`}
              className="shrink-0 text-muted-foreground"
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {item.editable && item.kind === "custom" && item.status === "open" ? (
              <DropdownMenuItem onSelect={() => void onUpdate({ action: "done" })}>
                Mark done
              </DropdownMenuItem>
            ) : null}
            {item.editable && item.status === "done" ? (
              <DropdownMenuItem onSelect={() => void onUpdate({ action: "restore" })}>
                Mark not done
              </DropdownMenuItem>
            ) : null}
            {canAddChannel ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Add another channel</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {CHANNEL_ADAPTERS.map((adapter) => (
                    <DropdownMenuItem key={adapter.id} onSelect={() => void onAddChannel(adapter)}>
                      {adapter.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {item.editable ? (
              <>
                {canAddChannel || item.kind === "custom" || item.status === "done" ? (
                  <DropdownMenuSeparator />
                ) : null}
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  Remove…
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}

/** Remove asks for an optional reason. The Lead and other admins read it under "Show removed". */
function RemoveDialog({
  item,
  busy,
  onClose,
  onConfirm,
}: {
  item: ChecklistItem | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const reasonId = useId();
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove "{item?.label}"?</DialogTitle>
          <DialogDescription>
            It moves under "Show removed". You can restore it at any time.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const text = reason.trim();
            setReason("");
            void onConfirm(text);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={reasonId}>Why? (optional)</Label>
            <Textarea
              id={reasonId}
              value={reason}
              maxLength={500}
              rows={3}
              placeholder="For example: we use email, not chat."
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setReason("");
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive-outline" disabled={busy}>
              Remove
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
