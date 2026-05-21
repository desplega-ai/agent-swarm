import { Mail, Plug } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Brand icon + Title-Case label lookup for platform identities.
 *
 * Inline monochrome SVGs (`currentColor` fill) for the canonical brands
 * (Slack, GitHub, Linear, GitLab, Jira, AgentMail) so they inherit text
 * color and render correctly in both light and dark themes. SVG path data
 * for Slack/GitHub/Linear/GitLab is the canonical mono mark from
 * simple-icons (CC0,
 * https://github.com/simple-icons/simple-icons/tree/develop/icons) — do not
 * substitute hand-drawn variants. Jira mark is the Atlassian Jira glyph
 * from svgrepo (https://www.svgrepo.com/show/503175/atlassian-jira.svg),
 * converted to monochrome by dropping the transparent background rect and
 * filling the path with currentColor. AgentMail mark is the icon component
 * of the AgentMail wordmark extracted from https://agentmail.to/ (inline
 * SVG in the site header); all five sub-paths already use currentColor.
 * Mail fallback for `email-alias` and Plug for unknown kinds.
 */

export const INTEGRATION_LABELS: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  linear: "Linear",
  gitlab: "GitLab",
  agentmail: "AgentMail",
  jira: "Jira",
  "email-alias": "Email alias",
};

export function getIntegrationLabel(kind: string): string {
  if (INTEGRATION_LABELS[kind]) return INTEGRATION_LABELS[kind];
  if (!kind) return "Unknown";
  return kind[0].toUpperCase() + kind.slice(1);
}

interface IconProps {
  className?: string;
}

function SlackIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role="img"
      aria-label="Slack"
    >
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
    </svg>
  );
}

function GitHubIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role="img"
      aria-label="GitHub"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function LinearIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role="img"
      aria-label="Linear"
    >
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  );
}

function GitLabIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role="img"
      aria-label="GitLab"
    >
      <path d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
    </svg>
  );
}

function JiraIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} role="img" aria-label="Jira">
      <path d="M11.53,2a4.37,4.37,0,0,0,4.35,4.35h1.78v1.7A4.35,4.35,0,0,0,22,12.4V2.84A.85.85,0,0,0,21.16,2H11.53M6.77,6.8a4.36,4.36,0,0,0,4.34,4.34h1.8v1.72a4.36,4.36,0,0,0,4.34,4.34V7.63a.84.84,0,0,0-.83-.83H6.77M2,11.6a4.34,4.34,0,0,0,4.35,4.34H8.13v1.72A4.36,4.36,0,0,0,12.47,22V12.43a.85.85,0,0,0-.84-.84H2Z" />
    </svg>
  );
}

function AgentMailIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 354 340"
      fill="currentColor"
      className={className}
      role="img"
      aria-label="AgentMail"
    >
      <path d="M318.029 88.3407C196.474 115.33 153.48 115.321 33.9244 88.3271C30.6216 87.5814 27.1432 88.9727 25.3284 91.8313L1.24109 129.774C-1.76483 134.509 0.965276 140.798 6.46483 141.898C152.613 171.13 197.678 171.182 343.903 141.835C349.304 140.751 352.064 134.641 349.247 129.907L326.719 92.0479C324.95 89.0744 321.407 87.5907 318.029 88.3407Z" />
      <path d="M75.9931 246.6L149.939 311.655C151.973 313.444 151.633 316.969 149.281 318.48L119.141 337.84C117.283 339.034 114.951 338.412 113.933 336.452L70.1276 252.036C68.0779 248.086 72.7553 243.751 75.9931 246.6Z" />
      <path d="M274.025 246.6L200.08 311.655C198.046 313.444 198.385 316.969 200.737 318.48L230.877 337.84C232.736 339.034 235.068 338.412 236.085 336.452L279.891 252.036C281.941 248.086 277.263 243.751 274.025 246.6Z" />
      <path d="M138.75 198.472L152.436 192.983C155.238 191.918 157.77 191.918 158.574 191.918C164.115 192.126 169.564 192.232 175.009 192.235C180.454 192.232 185.904 192.126 191.444 191.918C192.248 191.918 194.78 191.918 197.583 192.983L211.269 198.472C212.645 199.025 214.082 199.382 215.544 199.448C218.585 199.587 221.733 199.464 224.63 198.811C225.706 198.568 226.728 198.103 227.704 197.545L243.046 188.784C244.81 187.777 246.726 187.138 248.697 186.9L258.276 185.5H259.242H263.556L262.713 190.965L256.679 234.22C255.957 238.31 254.25 242.328 250.443 245.834L187.376 299.258C184.555 301.648 181.107 302.942 177.562 302.942H175.009H172.457C168.911 302.942 165.464 301.648 162.643 299.258L99.5761 245.834C95.7684 242.328 94.0614 238.31 93.3393 234.22L87.3059 190.965L86.4624 185.5H90.7771H91.7429L101.322 186.9C103.293 187.138 105.208 187.777 106.972 188.784L122.314 197.545C123.291 198.103 124.313 198.568 125.389 198.811C128.286 199.464 131.434 199.587 134.474 199.448C135.936 199.382 137.373 199.025 138.75 198.472Z" />
      <path d="M102.47 0.847827C205.434 44.796 156.456 42.1015 248.434 1.63153C252.885 -1.09955 258.353 1.88915 259.419 7.69219L269.235 61.1686L270.819 69.7893L263.592 71.8231L263.582 71.8259C190.588 92.3069 165.244 92.0078 86.7576 71.7428L79.1971 69.7905L80.9925 60.8681L91.8401 6.91975C92.9559 1.3706 98.105 -1.55777 102.47 0.847827Z" />
    </svg>
  );
}

/**
 * Render a brand/integration mark by `kind`. Renders monochrome — apply color
 * via the surrounding text-color class.
 */
export function IntegrationIcon({ kind, className }: { kind: string; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  switch (kind) {
    case "slack":
      return <SlackIcon className={cls} />;
    case "github":
      return <GitHubIcon className={cls} />;
    case "linear":
      return <LinearIcon className={cls} />;
    case "gitlab":
      return <GitLabIcon className={cls} />;
    case "jira":
      return <JiraIcon className={cls} />;
    case "agentmail":
      return <AgentMailIcon className={cls} />;
    case "email-alias":
      return <Mail className={cls} />;
    default:
      return <Plug className={cls} />;
  }
}
