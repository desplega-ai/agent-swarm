/**
 * Resolve a CSS custom property on `<html>` (any color syntax, including
 * `oklch()`) to `#rrggbb`, for controls such as `<input type="color">` that
 * only accept hex. Returns null outside a browser or when the value is unset.
 */
export function resolveCssVarToHex(name: string): string | null {
  if (typeof document === "undefined") return null;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Painting and reading back one pixel converts any color syntax the
  // browser understands to sRGB bytes.
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
