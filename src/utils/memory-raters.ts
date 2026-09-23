// Keep the dependency-free resolver in the plugin bundle so opencode's isolated
// runtime and the API/other workers execute the same defaults.
export { getMemoryRaterNames } from "../../plugin/opencode-plugins/lib/memory-raters";
