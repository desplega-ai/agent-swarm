/**
 * The `{{token}}` interpolation helpers moved to `@/utils/template` so that
 * non-workflow domains (prompts, worker commands, HTTP handlers, MCP tools)
 * can use them without depending on the workflow engine module.
 *
 * This module re-exports them for the workflow engine and existing tests.
 */
export {
  type DeepInterpolateOptions,
  deepInterpolate,
  type InterpolateResult,
  interpolate,
} from "@/utils/template";
