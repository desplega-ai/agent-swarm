/**
 * Codemode sandbox worker for the compiled agent-swarm binary.
 *
 * In a Bun binary, pi's `getCodemodeWorkerUrl()` loads the worker from
 * `./src/extensions/codemode/worker.js` next to the executable. The build
 * passes this file as an extra entrypoint with
 * `--root ./src/providers/pi-binary-root`, which embeds it at that path.
 * Keep the Dockerfile.worker compile line and both package.json
 * build:binary scripts in sync.
 */
import "@earendil-works/pi-codemode/worker";
