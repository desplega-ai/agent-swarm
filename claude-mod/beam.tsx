import type { ClientModule } from "claude-code";

// A Larson scanner: a bright cell sweeps across five cells and back, with a
// fading trail. It runs on the region's own frame clock, so a running task
// animates without the hooks module redrawing the pane.
const CELLS = 5;
const SHADES = ["█", "▓", "▒", "░"];
const PATH = [0, 1, 2, 3, 4, 3, 2, 1];

type Frame = { step: number };

const Beam: ClientModule<null, Frame> = (_props, surface) => {
  if (surface.state === undefined) {
    surface.setState({ step: 0 });
    surface.every(110, () => surface.setState({ step: (surface.state?.step ?? 0) + 1 }));
  }
  const at = PATH[(surface.state?.step ?? 0) % PATH.length] ?? 0;
  const cells = Array.from(
    { length: CELLS },
    (_, i) => SHADES[Math.min(Math.abs(i - at), SHADES.length - 1)],
  ).join("");
  const { Text } = surface.elements;
  return <Text color="yellow">{cells}</Text>;
};

export default Beam;
