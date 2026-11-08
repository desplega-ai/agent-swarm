import { ListTodo, MoreHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useChecklist, useChecklistMutation } from "@/api/hooks/use-checklist";
import {
  isOnboardingOpen,
  onboardingDoneCount,
  useOnboarding,
  useVisibleOnboardingSteps,
} from "@/api/hooks/use-onboarding";
import type {
  ChecklistAddRequest,
  ChecklistItem,
  ChecklistResponse,
  ChecklistUpdateRequest,
} from "@/api/types";
import { useOptionalStatusContext } from "@/app/status-context";
import { NEW_USE_CASE_HREF } from "@/components/home/favorites";
import { HomeWidget, HomeWidgetCount } from "@/components/home/home-widget";
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
import { failingChecks } from "@/lib/setup-checks";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";

/**
 * "Getting started" on Home: two phases in one list. Phase 1 (Set up) is the
 * low-level config: the setup wizard while it is open, then the health checks
 * that fail (the header badge's list). Phase 2 (Get the swarm working) is the
 * post-onboarding checklist: a channel, work tools, a first use case, the
 * team. Items check themselves from server signals; editing goes through the
 * API, which enforces who may change what (`editable` per item).
 *
 * Self-contained, in the shared `HomeWidget` chrome. Wrapper `id="setup"` is
 * the `/#setup` anchor.
 */
/**
 * Phase 1 rows (the open wizard, then failing checks). Undefined while the
 * status is unknown: the card then shows phase 2 only.
 */
function useSetupPhase(): SetupPhaseItem[] | undefined {
  const { data: onboarding } = useOnboarding();
  const steps = useVisibleOnboardingSteps();
  const status = useOptionalStatusContext()?.data;
  const canSetup = useCan("config.write.any");
  if (!status) return undefined;
  const setup: SetupPhaseItem[] = [];
  if (canSetup && onboarding && isOnboardingOpen(onboarding)) {
    setup.push({
      id: "wizard",
      label: "Finish the setup wizard",
      hint: `${onboardingDoneCount(onboarding.state, steps)} of ${steps.length} steps done`,
      href: "/setup",
      action: "Resume",
    });
  }
  for (const check of failingChecks(status)) {
    setup.push({
      id: check.milestone.id,
      label: check.milestone.label,
      hint: check.milestone.hint ?? null,
      href: check.milestone.action_url ?? null,
      action: "Fix",
      blocks: check.blocks,
    });
  }
  return setup;
}

/** Every visible item done and nothing left to set up. */
export function isSetupComplete(data: ChecklistResponse, setup: SetupPhaseItem[] | undefined) {
  const visible = data.items.filter((item) => item.status !== "removed");
  return visible.every((item) => item.done) && (!setup || setup.length === 0);
}

/** True once "Getting started" has nothing left; false while it loads or fails. */
export function useSetupComplete(): boolean {
  const setup = useSetupPhase();
  const { data } = useChecklist();
  return data ? isSetupComplete(data, setup) : false;
}

export function PostOnboardingChecklistCard({ className }: { className?: string }) {
  const setup = useSetupPhase();
  const { data, isError } = useChecklist();
  const mutation = useChecklistMutation();

  if (isError || !data) return null;

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
      setup={setup}
      busy={mutation.isPending}
      className={className}
      onAdd={(body) => run({ type: "add", body })}
      onUpdate={(id, body) => run({ type: "update", id, body })}
    />
  );
}

/** A Set up row: a failing check or the open wizard. */
export interface SetupPhaseItem {
  id: string;
  label: string;
  hint: string | null;
  href: string | null;
  action: string;
  /** No task can run until it passes. */
  blocks?: boolean;
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
  /** Phase 1 rows; empty = set up. Undefined while the status is unknown (no phase 1). */
  setup?: SetupPhaseItem[];
  busy?: boolean;
  className?: string;
  onAdd: (body: ChecklistAddRequest) => void | Promise<void>;
  onUpdate: (id: string, body: ChecklistUpdateRequest) => void | Promise<void>;
}

export function PostOnboardingChecklistView({
  data,
  setup,
  busy = false,
  className,
  onAdd,
  onUpdate,
}: PostOnboardingChecklistViewProps) {
  const [showRemoved, setShowRemoved] = useState(false);
  const [removing, setRemoving] = useState<ChecklistItem | null>(null);

  const visible = data.items.filter((item) => item.status !== "removed");
  const removed = data.items.filter((item) => item.status === "removed");
  const doneCount = visible.filter((item) => item.done).length;
  const setupDone = !setup || setup.length === 0;
  const count = `${doneCount} of ${visible.length}`;

  const addChannel = (adapter: (typeof CHANNEL_ADAPTERS)[number]) =>
    onAdd({
      kind: "channel",
      scope: "swarm",
      label: `Connect ${adapter.name}`,
      href: "/integrations/channels",
      meta: { adapter: adapter.id },
    });

  // Everything done: the card leaves Home, and Favorites takes the column.
  if (isSetupComplete(data, setup)) return null;

  return (
    <HomeWidget
      className={className}
      id="setup"
      title={setup ? "Getting started" : "Get the swarm working"}
      icon={<ListTodo className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      meta={
        <>
          <HomeWidgetCount>{count}</HomeWidgetCount>
          <Progress
            value={visible.length ? (doneCount / visible.length) * 100 : 0}
            aria-label={`${count} done`}
            className="h-1 w-10 shrink-0 bg-muted [&_[data-slot=progress-indicator]]:bg-status-success"
          />
        </>
      }
    >
      {setup ? (
        <>
          <PhaseHeader
            step={1}
            title="Set up"
            note={setupDone ? "Done" : `${setup.length} to fix`}
          />
          {setupDone ? (
            <p className="flex items-center gap-2 border-t border-border-subtle px-4 py-2.5 text-sm text-muted-foreground">
              <StatusIcon tone="success" focusable={false} />
              The swarm can run tasks.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle border-t border-border-subtle">
              {setup.map((item) => (
                <SetupRow key={item.id} item={item} />
              ))}
            </ul>
          )}
          <PhaseHeader step={2} title="Get the swarm working" note={count} />
        </>
      ) : null}
      <ul className={cn("divide-y divide-border-subtle", setup && "border-t border-border-subtle")}>
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

      {removed.length > 0 ? (
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
          if (item) {
            await onUpdate(item.id, { action: "remove", ...(reason ? { reason } : {}) });
          }
        }}
      />
    </HomeWidget>
  );
}

function PhaseHeader({ step, title, note }: { step: number; title: string; note: string }) {
  return (
    <div className="flex h-9 items-center gap-2 border-t border-border-subtle bg-muted/30 px-4 text-xs first:border-t-0">
      <span className="grid size-4 shrink-0 place-items-center rounded-full border border-border font-mono text-[10px] text-muted-foreground">
        {step}
      </span>
      <span className="font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
      <span className="ml-auto font-mono tabular-nums text-muted-foreground">{note}</span>
    </div>
  );
}

function SetupRow({ item }: { item: SetupPhaseItem }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <StatusIcon
        tone={item.blocks ? "error" : "warning"}
        label={item.blocks ? "Blocks every task" : "Needs attention"}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.label}</p>
        {item.hint ? <p className="text-xs text-muted-foreground">{item.hint}</p> : null}
      </div>
      {item.href ? (
        <Button asChild size="xs" variant="outline" className="shrink-0">
          <Link to={item.href}>{item.action}</Link>
        </Button>
      ) : null}
    </li>
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
  // A use case starts as a session that asks the Lead to plan it.
  const href = item.kind === "use_case" ? NEW_USE_CASE_HREF : item.href;
  const action = !item.done && href && item.editable ? href : null;
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
