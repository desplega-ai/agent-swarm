import {
  Bot,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
  MessageSquare,
  Send,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** DESIGN.md § Motion: the snappy curve, under the 300 ms budget. */
const SNAPPY = [0.2, 0, 0, 1] as const;
const ENTER = 0.22;
const EXIT = 0.14;

/** When each beat starts (seconds): an agent saves a file, you comment, it goes back. */
const SAVED = 0.15;
const COMMENTED = 0.95;
const SENT = 1.75;

const STEPS: Array<{ icon: LucideIcon; label: string }> = [
  { icon: Bot, label: "Agents save their work" },
  { icon: MessageSquare, label: "You read and comment" },
  { icon: Send, label: "Send it back to an agent" },
];

/**
 * A small picture of Comb: a file an agent saved, a comment on one
 * passage, and the comment sent back to the swarm. It plays its three beats
 * once on mount (transform and opacity only). Under reduced motion it shows
 * the last frame. Decorative: the step list under it carries the meaning.
 */
export function CombPreview({ className }: { className?: string }) {
  const play = !useReducedMotion();

  /** Fade in (and slide by `x`, `y` px) when the beat at `at` starts. */
  function enter(at: number, from: { x?: number; y?: number } = {}) {
    return {
      initial: play ? { opacity: 0, x: from.x ?? 0, y: from.y ?? 0 } : false,
      animate: { opacity: 1, x: 0, y: 0 },
      transition: { duration: ENTER, ease: SNAPPY, delay: at },
    } as const;
  }

  /** Fade out when the beat at `at` starts. */
  function leave(at: number) {
    return {
      initial: play ? { opacity: 1 } : false,
      animate: { opacity: 0 },
      transition: { duration: EXIT, ease: SNAPPY, delay: at },
    } as const;
  }

  return (
    <figure className={cn("space-y-3", className)}>
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-xl border border-border bg-card text-xs shadow-sm"
      >
        <div className="flex items-center gap-1.5 border-b border-border-subtle bg-surface px-3 py-2">
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">reports</span>
          <span className="text-muted-foreground">/</span>
          <span className="truncate font-medium">launch-plan.md</span>
          <motion.span
            {...enter(SAVED)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-muted-foreground"
          >
            <Bot className="size-3.5" />
            Saved by Researcher
          </motion.span>
        </div>

        <div className="grid sm:grid-cols-[10.5rem_minmax(0,1fr)]">
          <ul className="hidden space-y-0.5 border-r border-border-subtle p-2 sm:block">
            <TreeRow icon={FolderOpen}>reports</TreeRow>
            <motion.li
              {...enter(SAVED, { x: -6 })}
              className="flex items-center gap-1.5 rounded-md bg-accent py-1 pr-2 pl-5 font-medium"
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">launch-plan.md</span>
            </motion.li>
            <TreeRow icon={FileText} nested>
              research.md
            </TreeRow>
            <TreeRow icon={Folder}>notes</TreeRow>
          </ul>

          <div className="flex flex-col gap-3 p-4 md:flex-row md:items-start">
            <motion.div {...enter(SAVED, { y: 6 })} className="min-w-0 flex-1 space-y-2.5">
              <p className="text-sm font-semibold">Launch plan</p>
              <TextLine className="w-11/12" />
              <TextLine className="w-4/5" />
              <p className="relative w-fit max-w-full">
                {/* The commented passage, tinted like Comb's comment highlight. */}
                <motion.span
                  {...enter(COMMENTED)}
                  className="absolute -inset-x-1 -inset-y-0.5 rounded-sm bg-primary/15"
                />
                <span className="relative">Ship the beta to ten design partners.</span>
              </p>
              <TextLine className="w-3/5" />
            </motion.div>

            <motion.div
              {...enter(COMMENTED, { x: 8 })}
              className="w-full shrink-0 rounded-lg border border-border bg-card p-2.5 shadow-xs md:w-56"
            >
              <div className="flex items-center gap-1.5">
                <span className="flex size-5 items-center justify-center rounded-full bg-muted text-meta font-medium">
                  Y
                </span>
                <span className="font-medium">You</span>
                <span className="text-muted-foreground">now</span>
              </div>
              <p className="mt-1.5">
                <span className="rounded-sm bg-status-info/15 px-1 font-medium text-status-info-strong">
                  @swarm
                </span>{" "}
                add a rollout date for each partner.
              </p>
              <div className="relative mt-2 h-5">
                <motion.span
                  {...leave(SENT)}
                  className="absolute inset-0 inline-flex items-center gap-1 font-medium"
                >
                  <Send className="size-3.5" />
                  Send to swarm
                </motion.span>
                <motion.span
                  {...enter(SENT, { y: 4 })}
                  className="absolute inset-0 inline-flex items-center gap-1 text-muted-foreground"
                >
                  <Send className="size-3.5" />
                  Sent to the swarm
                </motion.span>
              </div>
            </motion.div>
          </div>
        </div>
      </div>

      <figcaption>
        <ol className="grid gap-2 sm:grid-cols-3">
          {STEPS.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}

function TreeRow({
  icon: Icon,
  nested = false,
  children,
}: {
  icon: LucideIcon;
  nested?: boolean;
  children: string;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-1.5 py-1 pr-2 text-muted-foreground",
        nested ? "pl-5" : "pl-1",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
    </li>
  );
}

/** A line of text, drawn as a bar. */
function TextLine({ className }: { className: string }) {
  return <span className={cn("block h-2 rounded-full bg-border", className)} />;
}
