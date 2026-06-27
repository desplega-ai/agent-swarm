import type { ReactNode, SVGProps } from "react";
import { Tooltip } from "./Tooltip.tsx";

// Inline SVGs ported from the main dashboard (ui/src/components/shared/harness-icon.tsx).
// Rendered inline (not <img>) so they inherit currentColor and expose nothing to AT —
// the tooltip/label next to the icon is the accessible name.

type IconProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "fill" | "xmlns" | "children">;

const ICON_BASE_24: SVGProps<SVGSVGElement> = {
  fill: "currentColor",
  fillRule: "evenodd",
  viewBox: "0 0 24 24",
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true,
  focusable: false,
};

const CLAUDE_PATH =
  "M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z";

function ClaudeIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, tooltip/label carries the name
    <svg
      aria-hidden
      fill="currentColor"
      viewBox="0 0 1200 1200"
      xmlns="http://www.w3.org/2000/svg"
      focusable={false}
      {...props}
    >
      <path d={CLAUDE_PATH} />
    </svg>
  );
}

function ClaudeManagedIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, tooltip/label carries the name
    <svg
      aria-hidden
      fill="currentColor"
      viewBox="0 0 1200 1200"
      xmlns="http://www.w3.org/2000/svg"
      focusable={false}
      {...props}
    >
      <path opacity="0.55" d={CLAUDE_PATH} />
      <circle cx="1050" cy="180" r="120" />
    </svg>
  );
}

function CodexIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, tooltip/label carries the name
    <svg aria-hidden {...ICON_BASE_24} {...props}>
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  );
}

function PiIcon(props: IconProps) {
  // Pi-Labs mark from pi.dev press-kit (P-glyph with adjacent i-dot square).
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, tooltip/label carries the name
    <svg
      aria-hidden
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 800 800"
      xmlns="http://www.w3.org/2000/svg"
      focusable={false}
      {...props}
    >
      <path d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z" />
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

function OpencodeIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, tooltip/label carries the name
    <svg aria-hidden {...ICON_BASE_24} {...props}>
      <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
    </svg>
  );
}

function DevinIcon(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, tooltip/label carries the name
    <svg aria-hidden {...ICON_BASE_24} {...props}>
      <path d="M3 3h7.4c5.16 0 8.6 3.7 8.6 9s-3.44 9-8.6 9H3V3zm3 3v12h4.4c3.5 0 5.6-2.4 5.6-6s-2.1-6-5.6-6H6z" />
      <circle cx="20.5" cy="12" r="1.6" />
    </svg>
  );
}

const ICONS: Record<string, (p: IconProps) => ReactNode> = {
  claude: ClaudeIcon,
  "claude-managed": ClaudeManagedIcon,
  codex: CodexIcon,
  pi: PiIcon,
  opencode: OpencodeIcon,
  devin: DevinIcon,
};

export const HARNESS_LABELS: Record<string, string> = {
  claude: "Claude",
  "claude-managed": "Claude Managed",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
  devin: "Devin",
};

/**
 * Harness/provider icon (item 19). Known harnesses render the ported dashboard
 * SVG (tooltip carries the name); unknown ones fall back to a text chip.
 */
export function HarnessIcon(props: {
  harness: string | null | undefined;
  /** Icon size in px; default 14. */
  size?: number;
  /** Render "icon + label" instead of "icon + tooltip". */
  showLabel?: boolean;
  /** No own Tooltip — for nesting inside another tooltip trigger (e.g. ConfigChip). */
  plain?: boolean;
}): ReactNode {
  const { harness } = props;
  if (!harness) return null;
  const size = props.size ?? 14;
  const Icon = ICONS[harness];
  const label = HARNESS_LABELS[harness] ?? harness;
  if (!Icon) {
    if (props.plain) return <span className="chip">{harness}</span>;
    return (
      <Tooltip text={label}>
        <span className="chip">{harness}</span>
      </Tooltip>
    );
  }
  if (props.plain) {
    return (
      <span className="harness-icon" role="img" aria-label={label}>
        <Icon width={size} height={size} />
      </span>
    );
  }
  if (props.showLabel) {
    return (
      <span className="harness-icon with-label">
        <Icon width={size} height={size} />
        <span>{label}</span>
      </span>
    );
  }
  return (
    <Tooltip text={label}>
      <span className="harness-icon" role="img" aria-label={label}>
        <Icon width={size} height={size} />
      </span>
    </Tooltip>
  );
}
