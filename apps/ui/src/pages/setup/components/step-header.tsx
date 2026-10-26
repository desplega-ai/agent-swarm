import type { OnboardingStepId } from "@/api/types";

/**
 * The centered title block of a `/setup` step, in the landing page's voice:
 * a mono "/ Step N of M" eyebrow, a large medium-weight title with tight
 * tracking, and one short line under it. A short viewport (`short:`) tightens
 * it. The shell moves focus to the title on a step change (`data-step-heading`).
 */
export function StepHeader({
  stepId,
  index,
  total,
  title,
  description,
}: {
  stepId: OnboardingStepId;
  index: number;
  total: number;
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto mb-8 flex max-w-[44rem] flex-col items-center text-center sm:mb-10 short:mb-6">
      <p className="font-mono text-meta uppercase tracking-[0.14em] text-muted-foreground">
        <span aria-hidden>/ </span>
        <span className="text-primary">Step {index}</span> of {total}
      </p>
      <h1
        data-step-heading={stepId}
        tabIndex={-1}
        className="mt-3 text-[1.75rem] leading-[1.1] font-medium tracking-[-0.035em] text-balance outline-none sm:text-4xl sm:leading-[1.05] short:mt-2 short:text-[2rem]"
      >
        {title}
      </h1>
      <p className="mt-3 max-w-[52ch] text-[0.9375rem] leading-relaxed text-pretty text-muted-foreground short:mt-2">
        {description}
      </p>
    </div>
  );
}
