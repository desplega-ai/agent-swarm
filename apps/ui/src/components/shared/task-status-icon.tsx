import { cn } from "@/lib/utils";

/**
 * The dashboard's lifecycle status icons: one thin-stroke SVG family, flat,
 * no shadows, all on the same 16x16 grid so they line up in a column.
 *
 * - `pending`: plain gray ring, not started.
 * - `active`: dashed amber ring that fades and turns slowly (static under
 *   reduced motion). Amber is the live color (DESIGN.md).
 * - `done`: solid green disc with a check.
 * - the rest reuse the ring and add a glyph (x, dash, bars, dot, !) in the
 *   tone of the state: failed, cancelled, skipped, paused, review, waiting,
 *   warning. `backlog` is the `pending` ring, dashed and still.
 *
 * `ProgressRing` is the aggregate form: a green arc, clockwise from 12
 * o'clock, in proportion to done / total.
 *
 * Colors are the status tokens (`-strong` stops, contrast-safe on the page
 * surface). `surface="inverse"` switches to the canonical stops for the
 * inverted tooltip surface, where `-strong` washes out.
 */
export type TaskStatusVariant =
  | "pending"
  | "backlog"
  | "active"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped"
  | "paused"
  | "review"
  | "waiting"
  | "warning";

type Surface = "default" | "inverse";

/**
 * Every lifecycle status the dashboard renders, task and run alike. Statuses
 * missing here (agent and service health) are not lifecycle states and keep
 * their dot in `StatusBadge`.
 */
const STATUS_VARIANT: Record<string, TaskStatusVariant> = {
  // Tasks
  draft: "active",
  backlog: "backlog",
  unassigned: "pending",
  offered: "active",
  reviewing: "review",
  pending: "pending",
  in_progress: "active",
  paused: "paused",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
  superseded: "skipped",
  aborted_limit: "warning",
  // Workflow and script runs, workflow steps
  running: "active",
  waiting: "waiting",
  skipped: "skipped",
  // Approval requests
  approved: "done",
  rejected: "failed",
  timeout: "warning",
};

export function taskStatusVariant(status: string): TaskStatusVariant | null {
  return STATUS_VARIANT[status] ?? null;
}

/** Ring color per variant: the canonical stop for `inverse`, the `-strong` stop otherwise. */
const RING_TONE: Record<Surface, Record<TaskStatusVariant, string>> = {
  default: {
    pending: "text-status-neutral/40",
    backlog: "text-status-neutral/40",
    active: "text-status-active-solid",
    done: "text-status-success-solid",
    failed: "text-status-error-strong",
    cancelled: "text-status-neutral/50",
    skipped: "text-status-neutral/50",
    paused: "text-status-paused-strong",
    review: "text-status-paused-strong",
    waiting: "text-status-pending-strong",
    warning: "text-status-warning-strong",
  },
  inverse: {
    pending: "text-status-neutral/60",
    backlog: "text-status-neutral/60",
    active: "text-status-active-solid",
    done: "text-status-success-solid",
    failed: "text-status-error",
    cancelled: "text-status-neutral/70",
    skipped: "text-status-neutral/70",
    paused: "text-status-paused",
    review: "text-status-paused",
    waiting: "text-status-pending",
    warning: "text-status-warning",
  },
};

/** Label color that sits next to the icon, so a badge reads as one tone. */
export const TASK_STATUS_TEXT: Record<TaskStatusVariant, string> = {
  pending: "text-status-neutral-strong",
  backlog: "text-status-neutral-strong",
  active: "text-status-active-strong",
  done: "text-status-success-strong",
  failed: "text-status-error-strong",
  cancelled: "text-status-neutral-strong",
  skipped: "text-status-neutral-strong",
  paused: "text-status-paused-strong",
  review: "text-status-paused-strong",
  waiting: "text-status-pending-strong",
  warning: "text-status-warning-strong",
};

/** Glyph color where it differs from the ring (the muted states keep a firmer glyph). */
const GLYPH_TONE: Partial<Record<TaskStatusVariant, string>> = {
  cancelled: "text-status-neutral",
  skipped: "text-status-neutral",
};

const CENTER = 8;
const RADIUS = 7.2;
const STROKE = 1.3;

/**
 * Dashes of the `active` ring, clockwise from 6 o'clock. Four vivid dashes
 * from 12 to 4:30 and a pale tail, as in the reference set; the slow turn
 * keeps the lopsided pattern readable as motion.
 */
const DASH_OPACITY = [0.26, 0.26, 0.26, 0.3, 1, 1, 1, 1];
const DASH_SLOT = 360 / DASH_OPACITY.length;
/** The pale dashes need more body on dark surfaces, or the ring reads as a short arc. */
const PALE_DASH: Record<Surface, string> = {
  default: "dark:[stroke-opacity:0.45]",
  inverse: "[stroke-opacity:0.4]",
};
/** Arc length of one dash before its round caps add ~stroke/2 at each end. */
const DASH_SPAN = 26;

function arcPoint(angle: number): string {
  const rad = (angle * Math.PI) / 180;
  return `${(CENTER + RADIUS * Math.cos(rad)).toFixed(3)} ${(CENTER + RADIUS * Math.sin(rad)).toFixed(3)}`;
}

const DASHES = DASH_OPACITY.map((opacity, i) => {
  const mid = 90 + i * DASH_SLOT;
  const start = mid - DASH_SPAN / 2;
  return {
    d: `M${arcPoint(start)}A${RADIUS} ${RADIUS} 0 0 1 ${arcPoint(start + DASH_SPAN)}`,
    opacity,
  };
});

/** Circumference of the ring: dash patterns for `backlog` derive from it. */
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const BACKLOG_PERIOD = CIRCUMFERENCE / 10;

function Ring({ className }: { className?: string }) {
  return (
    <circle
      cx={CENTER}
      cy={CENTER}
      r={RADIUS}
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      className={className}
    />
  );
}

/** Glyphs are drawn for a 7.1 ring; this fits them to the larger one. */
const GLYPH_SCALE = `translate(${CENTER} ${CENTER}) scale(1.1) translate(-${CENTER} -${CENTER})`;

function Glyph({ variant }: { variant: TaskStatusVariant }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (variant) {
    case "failed":
    case "cancelled":
      return <path d="M5.9 5.9L10.1 10.1M10.1 5.9L5.9 10.1" {...common} />;
    case "skipped":
      return <path d="M5.6 8H10.4" {...common} />;
    case "paused":
      return <path d="M6.4 5.7V10.3M9.6 5.7V10.3" {...common} />;
    case "review":
    case "waiting":
      return <circle cx={CENTER} cy={CENTER} r={1.7} fill="currentColor" />;
    case "warning":
      return (
        <>
          <path d="M8 4.9V8.5" {...common} />
          <circle cx={CENTER} cy={10.9} r={0.85} fill="currentColor" />
        </>
      );
    case "done":
      return <path d="M5.4 8.1L7.2 9.9L10.6 6.2" {...common} className="stroke-white" />;
    default:
      return null;
  }
}

export interface TaskStatusIconProps {
  /** A status string from any lifecycle (task, run, step, approval); unknown values render `pending`. */
  status?: string;
  /** Pick the glyph directly, for call sites with no status string. */
  variant?: TaskStatusVariant;
  surface?: Surface;
  /** Accessible name. Omit when the status is also written next to the icon. */
  label?: string;
  className?: string;
}

/** Task status as an icon. Sized by `className` (default 16px). */
export function TaskStatusIcon({
  status,
  variant: variantProp,
  surface = "default",
  label,
  className,
}: TaskStatusIconProps) {
  const variant = variantProp ?? (status ? taskStatusVariant(status) : null) ?? "pending";

  return (
    <svg
      viewBox="0 0 16 16"
      data-slot="task-status-icon"
      data-variant={variant}
      className={cn(
        "size-4 shrink-0",
        RING_TONE[surface][variant],
        variant === "active" && "animate-[spin_3s_linear_infinite] motion-reduce:animate-none",
        className,
      )}
      role={label ? "img" : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
    >
      {label ? <title>{label}</title> : null}
      {variant === "active" ? (
        DASHES.map((dash) => (
          <path
            key={dash.d}
            d={dash.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeOpacity={dash.opacity}
            className={dash.opacity < 1 ? PALE_DASH[surface] : undefined}
          />
        ))
      ) : variant === "done" ? (
        <circle cx={CENTER} cy={CENTER} r={7.95} fill="currentColor" />
      ) : variant === "backlog" ? (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeDasharray={`${BACKLOG_PERIOD * 0.55} ${BACKLOG_PERIOD * 0.45}`}
        />
      ) : (
        <Ring />
      )}
      <g transform={GLYPH_SCALE} className={GLYPH_TONE[variant]}>
        <Glyph variant={variant} />
      </g>
    </svg>
  );
}

export interface ProgressRingProps {
  done: number;
  total: number;
  surface?: Surface;
  /** Accessible name; defaults to "done of total". */
  label?: string;
  className?: string;
}

/**
 * Aggregate progress: gray ring with a green arc from 12 o'clock, clockwise.
 * Nothing done reads as the `pending` ring; everything done reads as `done`.
 */
export function ProgressRing({
  done,
  total,
  surface = "default",
  label,
  className,
}: ProgressRingProps) {
  const name = label ?? `${done} of ${total} done`;
  if (total > 0 && done >= total) {
    return <TaskStatusIcon variant="done" surface={surface} label={name} className={className} />;
  }
  const pct = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
  if (pct === 0) {
    return (
      <TaskStatusIcon variant="pending" surface={surface} label={name} className={className} />
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      data-slot="progress-ring"
      role="img"
      aria-label={name}
      className={cn("size-4 shrink-0", RING_TONE[surface].pending, className)}
    >
      <Ring />
      <circle
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE}
        strokeLinecap="round"
        pathLength={100}
        strokeDasharray={`${pct} ${100 - pct}`}
        transform={`rotate(-90 ${CENTER} ${CENTER})`}
        className={cn("stroke-current", RING_TONE[surface].done)}
      />
    </svg>
  );
}
