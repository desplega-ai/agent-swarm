import {
  AnimatePresence,
  motion,
  type TargetAndTransition,
  useReducedMotion,
  type Variants,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
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
 * One image of a crew member: the portrait (`base`), a mood pose, or an idle
 * frame (`blink`: eyes closed, `glance`: looks at the step beside it).
 */
type Frame = "base" | "blink" | "glance" | Pose;

/**
 * One crew member of the landing page (the hexagon jelly mascots) per setup
 * step, with a one-line tip. The portraits are 240 px WebP copies of the
 * landing's `public/yolo/agents/c/<id>.webp`, shown at 120 px. `poses` lists
 * the extra images in `public/setup-crew/<id>-<pose>.webp`. A mood with no
 * pose shows the portrait. Every member also has the idle frames
 * `<id>-blink.webp` and `<id>-glance.webp`.
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
    tip: "Comment on a file in Files to send it back to an agent.",
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

/**
 * What a crew member says when you poke it (a click on the portrait), in
 * order. Five pokes in quick succession make it spin once.
 */
const QUIPS: Record<string, ReadonlyArray<string>> = {
  lead: [
    "Hi! I route every task. Even this poke.",
    "Leads do not tickle. Mostly.",
    "Send me a goal. I like goals.",
  ],
  designer: [
    "Careful, I just centered that pixel.",
    "Is this hexagon centered? Asking for me.",
    "Nice color pick.",
  ],
  ops: ["Keys checked. Coffee next.", "Uptime is my favorite word.", "All systems go. Me too."],
  coder: ["It works on my machine.", "Ship it!", "One more commit, I promise."],
  researcher: [
    "Fun fact: hexagons tile a plane with no gaps.",
    "I will remember this poke.",
    "Searching... found you.",
  ],
  marketer: ["Tell your friends about me!", "Is this for the landing page?", "Best. Setup. Ever."],
  reviewer: ["Nit: you poked me.", "Looks good to me. Mostly.", "Approved, with one comment."],
  tester: ["Poke test: passed.", "Found a bug. It is you.", "Again? Okay, test two."],
};
const DIZZY_QUIP = "Okay, okay. I am awake!";
const DIZZY_POKES = 5;
const DIZZY_WINDOW_MS = 2500;
/** How long a poke shows the cheer pose, and how long the quip stays. */
const POKE_POSE_MS = 1100;
const QUIP_MS = 2600;

/** Where each spark lands (px from the center): a fan over the head. */
const SPARKS: ReadonlyArray<readonly [number, number]> = [
  [-56, -24],
  [-42, -50],
  [-16, -64],
  [16, -66],
  [42, -50],
  [56, -24],
  [0, -78],
];
const HEX_CLIP = "polygon(25% 6%, 75% 6%, 100% 50%, 75% 94%, 25% 94%, 0% 50%)";

/**
 * The animations of a poke, as variants. A poke switches between the A and
 * B copies, so each poke starts the animation again without a remount: the
 * guide sits in an `AnimatePresence initial={false}`, and that blocks the
 * first animation of a newly mounted element.
 */
const HOP: TargetAndTransition = {
  y: [0, -18, 0, -5, 0],
  scaleX: [1, 0.94, 1.08, 0.98, 1],
  scaleY: [1, 1.08, 0.9, 1.02, 1],
  rotate: [0, -6, 5, -2, 0],
  transition: { duration: 0.7, ease: "easeOut" },
};
/** Five quick pokes: one full spin in the air. */
const SPIN: TargetAndTransition = {
  y: [0, -26, 0],
  rotate: [0, 360],
  transition: { duration: 0.9, ease: [0.3, 0, 0.2, 1] },
};
const BODY_VARIANTS: Variants = { rest: {}, hopA: HOP, hopB: HOP, spinA: SPIN, spinB: SPIN };
const burst = (i: number): TargetAndTransition => ({
  x: [0, SPARKS[i][0]],
  y: [0, SPARKS[i][1]],
  opacity: [1, 0],
  scale: [0.4, 1],
  rotate: [0, 120],
  transition: { duration: 0.75, delay: i * 0.015, ease: [0.2, 0.6, 0.3, 1] },
});
const SPARK_VARIANTS: Variants = { rest: { opacity: 0 }, burstA: burst, burstB: burst };
/** A slow float between frame swaps. */
const FLOAT: TargetAndTransition = {
  y: [0, -4, 0],
  transition: { duration: 3.2, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
};
const FLOAT_VARIANTS: Variants = { still: { y: 0 }, float: FLOAT };

interface Poke {
  /** Counts every poke, so each one restarts the hop. */
  n: number;
  step: OnboardingStepId;
  quip: string;
  spin: boolean;
}

/** The guide shows only where the gutter beside the setup column fits it. */
const WIDE_QUERY = "(min-width: 1360px)";

const SNAPPY = [0.2, 0, 0, 1] as const;

/** The file name suffix of a frame. */
const FRAME_FILE: Record<Exclude<Frame, "base">, string> = {
  welcome: "wave",
  busy: "think",
  done: "cheer",
  blink: "blink",
  glance: "glance",
};

const IDLE_FRAMES: ReadonlyArray<Frame> = ["blink", "glance"];

/** The image of a frame. A pose the member does not have shows the portrait. */
function frameImage(member: CrewMember, frame: Frame): string {
  const known =
    frame !== "base" && (IDLE_FRAMES.includes(frame) || member.poses.includes(frame as Pose));
  return known
    ? `/setup-crew/${member.id}-${FRAME_FILE[frame as Exclude<Frame, "base">]}.webp`
    : `/setup-crew/${member.id}.webp`;
}

/**
 * What a crew member does while the step waits, as frames and how long each
 * one shows (ms). The loop starts with the mood's own pose and repeats. A
 * running check (`busy`) holds its pose.
 */
const LOOPS: Record<HexyMood, ReadonlyArray<readonly [Frame, number]>> = {
  idle: [
    ["base", 3600],
    ["blink", 450],
    ["base", 3000],
    ["glance", 1800],
  ],
  welcome: [
    ["welcome", 2600],
    ["base", 2400],
    ["blink", 450],
    ["base", 2000],
  ],
  done: [
    ["done", 2600],
    ["base", 2800],
    ["blink", 450],
    ["base", 2400],
    ["glance", 1600],
  ],
  busy: [["busy", 0]],
};

/**
 * The frame of the loop that shows now. Steps through the loop on timers
 * while `animate` is true. A new loop (a mood change) starts at its first
 * frame in the same render, so an old frame never flashes.
 */
function useFrameLoop(loop: ReadonlyArray<readonly [Frame, number]>, animate: boolean): Frame {
  const [state, setState] = useState({ loop, index: 0 });
  const current = state.loop === loop ? state : { loop, index: 0 };
  if (current !== state) setState(current);
  const { index } = current;
  useEffect(() => {
    if (!animate || loop.length < 2) return;
    const timer = window.setTimeout(
      () =>
        setState((prev) =>
          prev.loop === loop ? { loop, index: (prev.index + 1) % loop.length } : prev,
        ),
      loop[index][1],
    );
    return () => window.clearTimeout(timer);
  }, [loop, index, animate]);
  return loop[index][0];
}

function preload(src: string) {
  const img = new Image();
  img.src = src;
}

/**
 * The crew member of the current step, beside the centered setup column (in
 * its left gutter, centered in the visible height) on wide screens, with the
 * tip in a speech bubble. Hidden below 1360 px. A step change swaps it with a
 * short pop-in. While it shows, it floats slowly and plays its mood's loop
 * (`LOOPS`): each frame swap is a crossfade with a small hop. Reduced motion
 * shows the mood's pose with no movement and no fade. Place it inside a
 * `relative` container that spans the step column.
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
  const [wide] = useState(() => window.matchMedia?.(WIDE_QUERY).matches ?? false);
  // Reduced motion and narrow screens (the guide is hidden) keep the mood's pose.
  const frame = useFrameLoop(LOOPS[mood], wide && !reduceMotion);

  // A click on the portrait pokes it: a hop, its cheer pose, a quip in the
  // bubble, and a few hexagons. A poke belongs to its step: a step change ends it.
  const [poke, setPoke] = useState<Poke | null>(null);
  const [posing, setPosing] = useState(false);
  const [quipping, setQuipping] = useState(false);
  const recentPokes = useRef<number[]>([]);
  // The float starts one frame after the mount, for the same reason as the
  // poke variants (a change in the mount commit still counts as the first).
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setFloating(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  const onPoke = () => {
    const now = Date.now();
    const recent = [...recentPokes.current.filter((t) => now - t < DIZZY_WINDOW_MS), now];
    const spin = recent.length >= DIZZY_POKES;
    recentPokes.current = spin ? [] : recent;
    const quips = QUIPS[member.id] ?? [];
    setPoke((prev) => {
      const n = (prev?.n ?? 0) + 1;
      const quip = spin ? DIZZY_QUIP : (quips[(n - 1) % quips.length] ?? member.tip);
      return { n, step: stepId, quip, spin };
    });
    setPosing(true);
    setQuipping(true);
  };
  useEffect(() => {
    if (!poke) return;
    const pose = window.setTimeout(() => setPosing(false), POKE_POSE_MS);
    const quip = window.setTimeout(() => setQuipping(false), QUIP_MS);
    return () => {
      window.clearTimeout(pose);
      window.clearTimeout(quip);
    };
  }, [poke]);
  const poked = poke !== null && poke.step === stepId ? poke : null;
  const shownText = poked && quipping ? poked.quip : text;
  const pokeFrame: Frame = member.poses.includes("done") ? "done" : "blink";
  const pair = poked && poked.n % 2 === 0 ? "B" : "A";
  const bodyVariant = poked ? `${poked.spin ? "spin" : "hop"}${pair}` : "rest";
  const sparkVariant = poked ? `burst${pair}` : "rest";
  const src = frameImage(
    member,
    poked && posing ? pokeFrame : reduceMotion ? LOOPS[mood][0][0] : frame,
  );

  // Warm the cache on a wide screen, so a swap never shows an empty slot:
  // every portrait once (about 95 KB), and the frames of the current step.
  useEffect(() => {
    if (!wide) return;
    for (const crew of Object.values(SETUP_CREW)) preload(frameImage(crew, "base"));
  }, [wide]);
  useEffect(() => {
    if (!wide) return;
    const crew = SETUP_CREW[stepId];
    for (const extra of [...crew.poses, ...IDLE_FRAMES]) preload(frameImage(crew, extra));
  }, [stepId, wide]);

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
        <p aria-live="polite" className="mt-1 text-[0.8125rem] leading-snug text-foreground">
          {shownText}
        </p>
        {/* The tail points down at the portrait. */}
        <span
          aria-hidden
          className="absolute -bottom-[7px] left-12 size-3 rotate-45 border-r border-b border-border bg-card"
        />
      </div>
      <button
        type="button"
        onClick={onPoke}
        aria-label={`Poke the ${member.name.toLowerCase()}`}
        className="relative mt-3 ml-4 block size-[120px] cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* A soft floor under the feet. */}
        <span
          aria-hidden
          className="absolute bottom-1 left-1/2 h-3 w-20 -translate-x-1/2 rounded-full bg-foreground/10 blur-[6px]"
        />
        {reduceMotion ? (
          <span className="absolute inset-0 block">{image}</span>
        ) : (
          // A slow float keeps the guide alive between frame swaps. Both
          // frames stay stacked while they crossfade: no empty frame.
          <motion.span
            className="absolute inset-0 block"
            variants={FLOAT_VARIANTS}
            initial="still"
            animate={floating ? "float" : "still"}
          >
            <motion.span
              className="absolute inset-0 block"
              style={{ originY: 1 }}
              variants={BODY_VARIANTS}
              initial="rest"
              animate={bodyVariant}
            >
              <AnimatePresence initial={false}>
                <motion.span
                  key={src}
                  className="absolute inset-0 block"
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
                </motion.span>
              </AnimatePresence>
            </motion.span>
          </motion.span>
        )}
        {reduceMotion ? null : (
          <span aria-hidden className="pointer-events-none absolute inset-0 block">
            {SPARKS.map(([x, y], i) => (
              <motion.span
                key={`${x},${y}`}
                className="absolute top-[45%] left-1/2 -mt-1.5 -ml-1.5 block size-3 bg-primary"
                style={{ clipPath: HEX_CLIP }}
                custom={i}
                variants={SPARK_VARIANTS}
                initial="rest"
                animate={sparkVariant}
              />
            ))}
          </span>
        )}
      </button>
    </>
  );

  return (
    <aside
      aria-label="Setup tip"
      className="absolute inset-y-0 right-full mr-7 hidden w-48 min-[1360px]:block"
    >
      {/* Centered in the visible height of the step, also while it scrolls. */}
      <div className="sticky top-1/2 -translate-y-1/2">
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
