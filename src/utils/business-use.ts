/**
 * The only module that may import `@desplega.ai/business-use`.
 *
 * Business-use events ship their `data` payload to an external backend.
 * Call sites put task output, failure reasons and error strings there, so
 * `ensure` scrubs `data` before forwarding. Validators and filters are
 * serialized and evaluated on the backend: they pass through untouched and
 * must stay self-contained. Biome's `noRestrictedImports` rule keeps new call
 * sites on this wrapper.
 */
import { ensure as rawEnsure } from "@desplega.ai/business-use";
import { scrubObject } from "./secret-scrubber";

export { initialize, shutdown } from "@desplega.ai/business-use";

export const ensure: typeof rawEnsure = (options) => {
  rawEnsure({ ...options, data: scrubObject(options.data) });
};
