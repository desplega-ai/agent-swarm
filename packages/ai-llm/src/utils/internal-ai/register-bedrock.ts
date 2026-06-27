/**
 * Bun-bundled Bedrock provider registration.
 *
 * pi-ai loads its Amazon Bedrock provider lazily via a dynamic
 * `import("./amazon-bedrock.js")` (see
 * `node_modules/@earendil-works/pi-ai/dist/providers/register-builtins.js`).
 * Bun's `--compile` bundler treats that specifier as runtime-resolved, so the
 * built `agent-swarm` / `agent-swarm-api` binaries embed the module but cannot
 * resolve it from inside the Bun virtual filesystem. The first call to any
 * `bedrock-converse-stream` model from a compiled binary fails with:
 *
 *     ResolveMessage: Cannot find module './amazon-bedrock.js'
 *                     from '/$bunfs/root/agent-swarm'
 *
 * pi-ai 0.75+ exposes `setBedrockProviderModule()` plus a Bun-traceable
 * `@earendil-works/pi-ai/bedrock-provider` subpath specifically to let bundle
 * consumers wire the module statically. The override lives outside the
 * api-registry Map, so it survives `resetApiProviders()` calls triggered by
 * `AgentSession.reload()` and `ModelRegistry.refresh()`.
 *
 * Mirrors the equivalent fix upstream in pi-mono:
 *   https://github.com/mariozechner/pi-mono/pull/2350
 *
 * This module has side effects on import. Each `bun build --compile` entry
 * point (`src/cli.tsx` for worker/lead, `src/http.ts` for the API) imports it
 * before any code that may instantiate a Bedrock model. The import is a no-op
 * under non-compiled `bun run`, where the lazy dynamic import resolves
 * normally against `node_modules/`.
 */

import { setBedrockProviderModule } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";

setBedrockProviderModule(bedrockProviderModule);
