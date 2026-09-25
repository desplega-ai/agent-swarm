import { SetupCard } from "@/components/onboarding/setup-card";
import { THEME_MODES, ThemePresetPicker } from "@/components/shared/theme-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useTheme } from "@/hooks/use-theme";

const MODE_OPTIONS = THEME_MODES.map(({ id, label, icon: Icon, hint }) => ({
  value: id,
  label: (
    <>
      <Icon aria-hidden="true" />
      {label}
    </>
  ),
  tooltip: hint,
}));

/**
 * The dashboard theme, the same preference as Settings > Appearance. It lives
 * in localStorage, so a pick applies at once and saves nothing to the swarm.
 */
export function ThemeCard() {
  const { mode, setMode } = useTheme();

  return (
    <SetupCard
      title="Theme"
      description="This browser only. Each operator picks their own."
      actions={
        <SegmentedControl
          size="sm"
          aria-label="Color mode"
          value={mode}
          onValueChange={setMode}
          options={MODE_OPTIONS}
        />
      }
    >
      <ThemePresetPicker compact />
    </SetupCard>
  );
}
