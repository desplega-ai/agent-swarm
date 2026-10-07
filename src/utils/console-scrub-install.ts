// Side-effect entry: import first so every later console wrapper and every
// module-load log line goes through the scrub.
import { installConsoleScrub } from "./console-scrub";

installConsoleScrub();
