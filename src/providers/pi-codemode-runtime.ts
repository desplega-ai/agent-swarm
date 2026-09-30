/**
 * Point pi's codemode at the QuickJS wasm that `bun build --compile` embeds.
 *
 * pi resolves the wasm with `createRequire(import.meta.url).resolve(...)`
 * unless an embedded path was set, and that resolve fails inside a compiled
 * binary's `$bunfs`. pi's own Bun binary sets the path in its entry
 * (dist/bun/runtime-setup.js); our binary has a different entry, so this
 * module does the same. Outside a binary, the import is the file on disk.
 *
 * `setEmbeddedQuickJSWasmPath` is not in the package `exports` map, so the
 * import goes through the file path. It is the same module instance pi's
 * codemode reads, and tsc fails if pi moves or drops it.
 */
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };
import { setEmbeddedQuickJSWasmPath } from "../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";

setEmbeddedQuickJSWasmPath(quickjsWasmPath);
