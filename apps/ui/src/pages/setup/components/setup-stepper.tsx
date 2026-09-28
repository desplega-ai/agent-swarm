import {
  Blocks,
  Bot,
  Brain,
  Check,
  Fingerprint,
  type LucideIcon,
  Plug,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { LayoutGroup, motion, type Transition } from "motion/react";
import { ONBOARDING_STEPS } from "@/api/hooks/use-onboarding";
import type { OnboardingStepId, OnboardingStepStatus } from "@/api/types";
import {
  SKIPPED_HATCH,
  STEP_STATUS_WORD,
  STEP_TONE_CLASS,
} from "@/components/onboarding/step-status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** One spring for the active pill, the item reflow, and the connector fill. */
const SPRING: Transition = { type: "spring", stiffness: 520, damping: 42, mass: 0.9 };
/** Motion corrects radius under layout scale only when it is set as a style. */
const ROUND = { borderRadius: 9999 };

/** One icon per step, in the marker. The number stays in the tooltip. */
const STEP_ICON: Record<OnboardingStepId, LucideIcon> = {
  connect: Plug,
  name: Fingerprint,
  ai: Sparkles,
  agents: Bot,
  memory: Brain,
  integrations: Blocks,
  first_task: Send,
};

interface SetupStepperProps {
  statuses: Record<OnboardingStepId, OnboardingStepStatus>;
  current: OnboardingStepId;
  /** Omit before a connection exists: the steps show but do not navigate. */
  onSelect?: (step: OnboardingStepId) => void;
}

/**
 * The header stepper: seven round markers, each with its step icon, joined by
 * connectors that fill amber as steps settle. Status reads at a glance: a
 * done step is amber with a check badge, a failed one red with an x badge, a
 * skipped one hatched. The current step is a solid amber pill with its label
 * (icon only below 640px); the pill slides between steps on a spring.
 */
export function SetupStepper({ statuses, current, onSelect }: SetupStepperProps) {
  return (
    <nav aria-label="Setup steps">
      <LayoutGroup id="setup-stepper">
        <ol className="flex items-center gap-0.5 sm:gap-1.5">
          {ONBOARDING_STEPS.map(({ id, label }, index) => {
            const previous = index > 0 ? statuses[ONBOARDING_STEPS[index - 1].id] : null;
            return (
              <li key={id} className="flex items-center gap-0.5 sm:gap-1.5">
                {previous ? <Connector status={previous} /> : null}
                <StepMarker
                  number={index + 1}
                  icon={STEP_ICON[id]}
                  label={label}
                  status={statuses[id]}
                  current={id === current}
                  onSelect={onSelect ? () => onSelect(id) : undefined}
                />
              </li>
            );
          })}
        </ol>
      </LayoutGroup>
    </nav>
  );
}

/** Track between two markers. Fills when the step on its left is done (amber) or skipped (neutral). */
function Connector({ status }: { status: OnboardingStepStatus }) {
  const filled = status === "done" || status === "skipped";
  return (
    <motion.span
      layout="position"
      transition={SPRING}
      aria-hidden="true"
      className="relative block h-0.5 w-2 overflow-hidden rounded-full bg-border sm:w-4 md:w-5"
    >
      <motion.span
        initial={false}
        animate={{ scaleX: filled ? 1 : 0 }}
        transition={SPRING}
        className={cn(
          "absolute inset-0 origin-left rounded-full",
          status === "skipped" ? "bg-status-neutral/45" : "bg-primary",
        )}
      />
    </motion.span>
  );
}

function StepMarker({
  number,
  icon: Icon,
  label,
  status,
  current,
  onSelect,
}: {
  number: number;
  icon: LucideIcon;
  label: string;
  status: OnboardingStepStatus;
  current: boolean;
  onSelect?: () => void;
}) {
  const word = STEP_STATUS_WORD[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          type="button"
          layout
          transition={SPRING}
          style={status === "skipped" && !current ? { ...ROUND, ...SKIPPED_HATCH } : ROUND}
          // `aria-disabled`, not `disabled`: the tooltip still explains the step.
          aria-disabled={onSelect ? undefined : true}
          onClick={onSelect}
          aria-current={current ? "step" : undefined}
          aria-label={`Step ${number}: ${label}, ${current ? `current, ${word.toLowerCase()}` : word.toLowerCase()}`}
          className={cn(
            // 36px slop: the marker pitch, so neighbours' hit areas meet but never overlap.
            "hit-area relative isolate flex h-6 min-w-6 shrink-0 [--hit-size:36px] items-center justify-center font-mono text-[11px] leading-none outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            current
              ? "gap-1.5 px-1.5 font-semibold text-primary-foreground sm:pr-2.5"
              : cn(
                  "border-[1.5px] hover-linger",
                  STEP_TONE_CLASS[status],
                  onSelect && "hover:border-primary/60 hover:text-foreground",
                ),
          )}
        >
          {current ? (
            <motion.span
              layoutId="setup-stepper-active"
              transition={SPRING}
              style={ROUND}
              aria-hidden="true"
              className="absolute inset-0 -z-10 bg-primary shadow-xs ring-4 ring-primary/15"
            />
          ) : null}
          <motion.span layout="position" transition={SPRING} className="flex items-center">
            <Icon className="size-3" strokeWidth={2.25} aria-hidden="true" />
          </motion.span>
          {current ? (
            <motion.span
              layout="position"
              transition={SPRING}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.2, delay: 0.05 } }}
              className="hidden font-sans text-xs whitespace-nowrap sm:inline"
            >
              {label}
            </motion.span>
          ) : null}
          <StatusBadge status={status} />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        <span className="font-medium">
          {number}. {label}
        </span>
        <span className="ml-1.5 opacity-70">{onSelect ? word : "Connect first"}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** Corner badge: a check for done, an x for failed. Other states have none. */
function StatusBadge({ status }: { status: OnboardingStepStatus }) {
  if (status !== "done" && status !== "failed") return null;
  const Glyph = status === "done" ? Check : X;
  return (
    <motion.span
      layout="position"
      transition={SPRING}
      aria-hidden="true"
      className={cn(
        "absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full ring-2 ring-background",
        status === "done"
          ? "bg-primary text-primary-foreground"
          : "bg-status-error text-status-error-foreground",
      )}
    >
      <Glyph className="size-2" strokeWidth={4} />
    </motion.span>
  );
}
