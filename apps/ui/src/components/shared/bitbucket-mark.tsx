import type { SVGProps } from "react";

// Bitbucket mark: the simple-icons mono glyph (CC0), same path as
// public/integration-logos/bitbucket.svg. lucide-react ships no Bitbucket icon,
// so this stands in next to its Github and Gitlab icons.
const BITBUCKET_PATH =
  "M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z";

type BitbucketMarkProps = Omit<SVGProps<SVGSVGElement>, "viewBox" | "fill" | "xmlns" | "children">;

export function BitbucketMark(props: BitbucketMarkProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, the label next to it provides the accessible name
    <svg
      aria-hidden
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      focusable={false}
      {...props}
    >
      <path d={BITBUCKET_PATH} />
    </svg>
  );
}
