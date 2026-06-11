import type { Scenario } from "../src/types.ts";
import { helloFile } from "./hello-file.ts";
import { quickReasoning } from "./quick-reasoning.ts";

export const scenarios: Scenario[] = [helloFile, quickReasoning];

export const DEFAULT_SCENARIO_IDS = ["hello-file"];
