import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import type { OnboardingStepId } from "@/api/types";

/**
 * What the step is doing, as the crew member shows it:
 * - `welcome`: nothing is connected yet (the lead waves).
 * - `idle`: the step waits for the operator.
 * - `busy`: a check runs (a worker checks a key, a test runs).
 * - `done`: the step passed.
 */
export type HexyMood = "welcome" | "idle" | "busy" | "done";

type Pose = Exclude<HexyMood, "idle">;

/**
 * One crew member of the landing page (the hexagon jelly mascots) per setup
 * step, with a one-line tip. The portraits are 240 px WebP copies of the
 * landing's `public/yolo/agents/c/<id>.webp`, shown at 120 px. `poses` lists
 * the extra images in `public/setup-crew/<id>-<pose>.webp`. A mood with no
 * pose shows the portrait.
 */
interface CrewMember {
  /** File name under `public/setup-crew/`. */
  id: string;
  /** The role on the landing page. */
  name: string;
  tip: string;
  poses: ReadonlyArray<Pose>;
}

export const SETUP_CREW: Record<OnboardingStepId, CrewMember> = {
  // The lead routes every request: it greets the operator first.
  connect: {
    id: "lead",
    name: "Lead",
    tip: "Pick what you work on. The swarm suggests first tasks that fit it.",
    poses: ["welcome", "done"],
  },
  // The designer owns the look: name, logo, and color.
  name: {
    id: "designer",
    name: "Designer",
    tip: "Add your website. The logo and the color follow it.",
    poses: ["done"],
  },
  // Ops holds the keys and the checklist.
  ai: {
    id: "ops",
    name: "Ops",
    tip: "One verified key is enough. A worker checks each key you save.",
    poses: ["busy", "done"],
  },
  // The coder is the agent whose model you pick.
  agents: {
    id: "coder",
    name: "Coder",
    tip: "Optimal fits most swarms. Change a level later in the agent settings.",
    poses: ["done"],
  },
  // The researcher finds past work.
  memory: {
    id: "researcher",
    name: "Researcher",
    tip: "Memory search finds past work by meaning, not only by keyword.",
    poses: ["busy", "done"],
  },
  // The marketer speaks in your team's channels.
  integrations: {
    id: "marketer",
    name: "Marketer",
    tip: "Connect Slack, and your team can send tasks from any channel.",
    poses: ["done"],
  },
  // The reviewer reads and comments: that is Comb.
  files: {
    id: "reviewer",
    name: "Reviewer",
    tip: "Comment on a file in Comb to send it back to an agent.",
    poses: [],
  },
  // The tester tries the swarm for the first time.
  first_task: {
    id: "tester",
    name: "Tester",
    tip: "Send a goal, not steps. The lead plans it and gives parts to workers.",
    poses: ["done"],
  },
};

/** Step 1 before a connection exists: the lead points at the install prompt. */
export const INSTALL_TIP =
  "Your coding agent ends with a link. The link fills in this form for you.";

/** Step 1 when nobody has to pick a user (a token or the deployment fixes it). */
export const CONNECTED_TIP = "Each step saves as you go. Minimize at any time and come back later.";

/** The guide shows only where the gutter beside the setup column fits it. */
const WIDE_QUERY = "(min-width: 1360px)";

const SNAPPY = [0.2, 0, 0, 1] as const;

/** The image file of a pose. */
const POSE_FILE: Record<Pose, string> = { welcome: "wave", busy: "think", done: "cheer" };

function imageOf(member: CrewMember, mood: HexyMood): string {
  const pose = mood === "idle" || !member.poses.includes(mood) ? null : mood;
  return pose
    ? `/setup-crew/${member.id}-${POSE_FILE[pose]}.webp`
    : `/setup-crew/${member.id}.webp`;
}

function preload(src: string) {
  const img = new Image();
  img.src = src;
}

/**
 * The crew member of the current step, beside the centered setup column (in
 * its left gutter) on wide screens, with the tip in a speech bubble. Hidden
 * below 1360 px. A step change swaps it with a short pop-in. A mood change
 * swaps the pose with a crossfade and a small hop. Reduced motion swaps both
 * with no movement and no fade. Place it inside a `relative` container that
 * spans the step column.
 */
export function HexyGuide({
  stepId,
  mood,
  tip,
}: {
  stepId: OnboardingStepId;
  mood: HexyMood;
  tip?: string;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const member = SETUP_CREW[stepId];
  const text = tip ?? member.tip;
  const src = imageOf(member, mood);

  // Warm the cache on a wide screen, so a swap never shows an empty slot:
  // every portrait once (about 95 KB), and the poses of the current step.
  useEffect(() => {
    if (!window.matchMedia?.(WIDE_QUERY).matches) return;
    for (const crew of Object.values(SETUP_CREW)) preload(imageOf(crew, "idle"));
  }, []);
  useEffect(() => {
    if (!window.matchMedia?.(WIDE_QUERY).matches) return;
    const crew = SETUP_CREW[stepId];
    for (const pose of crew.poses) preload(imageOf(crew, pose));
  }, [stepId]);

  const image = (
    <img
      src={src}
      alt=""
      width={120}
      height={120}
      decoding="async"
      draggable={false}
      className="size-[120px] object-contain select-none"
    />
  );

  const content = (
    <>
      <div className="relative rounded-2xl border border-border bg-card px-3.5 py-2.5 shadow-sm">
        <p className="font-mono text-meta uppercase tracking-[0.12em] text-muted-foreground">
          {member.name}
        </p>
        <p className="mt-1 text-[0.8125rem] leading-snug text-foreground">{text}</p>
        {/* The tail points down at the portrait. */}
        <span
          aria-hidden
          className="absolute -bottom-[7px] left-12 size-3 rotate-45 border-r border-b border-border bg-card"
        />
      </div>
      <div className="relative mt-3 ml-4 size-[120px]">
        {/* A soft floor under the feet. */}
        <span
          aria-hidden
          className="absolute bottom-1 left-1/2 h-3 w-20 -translate-x-1/2 rounded-full bg-foreground/10 blur-[6px]"
        />
        {reduceMotion ? (
          <div className="absolute inset-0">{image}</div>
        ) : (
          // Both poses stay stacked while they crossfade: no empty frame.
          <AnimatePresence initial={false}>
            <motion.div
              key={src}
              className="absolute inset-0"
              initial={{ opacity: 0, y: 6 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: {
                  opacity: { duration: 0.18, ease: SNAPPY },
                  y: { type: "spring", stiffness: 520, damping: 22, mass: 0.7 },
                },
              }}
              exit={{ opacity: 0, transition: { duration: 0.16, ease: SNAPPY } }}
            >
              {image}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </>
  );

  return (
    <aside
      aria-label="Setup tip"
      className="absolute inset-y-0 right-full mr-7 hidden w-48 min-[1360px]:block"
    >
      <div className="sticky top-10">
        {reduceMotion ? (
          <div key={stepId}>{content}</div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={stepId}
              initial={{ opacity: 0, y: 10, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.26, ease: SNAPPY } }}
              exit={{ opacity: 0, y: 4, transition: { duration: 0.12, ease: SNAPPY } }}
              style={{ originX: 0.3, originY: 1 }}
            >
              {content}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </aside>
  );
}
