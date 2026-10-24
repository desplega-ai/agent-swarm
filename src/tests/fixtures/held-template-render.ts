import { configureHttpResolver, resetHttpResolver } from "../../prompts/resolver";

export const HELD_NOTE_TEXT = "Finish current work and complete or defer.";

/**
 * Point the prompt resolver at a local server whose template responses wait
 * for `release()`, so a test can choose when an async note render finishes.
 * `requested` resolves on the first render request. `stop()` releases,
 * restores the resolver and closes the server.
 */
export function holdTemplateRender(): {
  release: () => void;
  requested: Promise<void>;
  stop: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let onRequest!: () => void;
  const requested = new Promise<void>((resolve) => {
    onRequest = resolve;
  });
  const server = Bun.serve({
    port: 0,
    async fetch() {
      onRequest();
      await gate;
      return Response.json({ text: HELD_NOTE_TEXT, skipped: false, unresolved: [] });
    },
  });
  configureHttpResolver(`http://localhost:${server.port}`, "test");
  return {
    release,
    requested,
    stop: () => {
      release();
      resetHttpResolver();
      server.stop(true);
    },
  };
}
