/**
 * Restore the process-wide prompt-template registry after a test file has
 * called clearTemplateDefinitions().
 *
 * Template modules register their definitions as a module-load side effect,
 * and bun caches modules per process — so once a file clears the registry,
 * every later test file whose import graph already evaluated the template
 * modules silently resolves empty templates (empty task bodies, no visible
 * throw). Which files run "later" depends on bun's platform-specific file
 * order, so the breakage is typically CI(Linux)-only. Cache-busted dynamic
 * imports re-run the registerTemplate() side effects unconditionally.
 *
 * Call this from afterAll in any file that clears the registry; victims of
 * historical leaks also call it defensively from beforeAll/beforeEach (see
 * agentmail-handlers, heartbeat-checklist, prompt-template-remaining).
 */
export async function restoreAllTemplateDefinitions(): Promise<void> {
  const ts = Date.now();
  await import(`../agentmail/templates?t=${ts}`);
  await import(`../commands/templates?t=${ts}`);
  await import(`../github/templates?t=${ts}`);
  await import(`../gitlab/templates?t=${ts}`);
  await import(`../heartbeat/templates?t=${ts}`);
  await import(`../jira/templates?t=${ts}`);
  await import(`../linear/templates?t=${ts}`);
  await import(`../prompts/session-templates?t=${ts}`);
  await import(`../slack/templates?t=${ts}`);
  await import(`../tools/templates?t=${ts}`);
}
