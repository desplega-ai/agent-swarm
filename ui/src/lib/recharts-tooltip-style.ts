// Shared `contentStyle` for recharts <Tooltip>. Pre-Phase-10 each chart
// hand-rolled the same object; using the shared constant keeps the dashboard
// usage chart, the standalone usage page chart, and any future chart visually
// in lockstep with the design tokens.

export const rechartsTooltipStyle = {
  background: "var(--color-card)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--color-foreground)",
} as const;
