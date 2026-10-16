// Keep Mini's namespace export live in Bun's standalone bundle.
import * as mini from "zod/mini";

export * from "zod/mini";
export const z = mini.z;
