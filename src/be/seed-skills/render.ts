/**
 * Rendering of a skill's SKILL.md from its template sources
 * (`templates/skills/<name>/{config.json,content.md}`).
 *
 * Leaf module on purpose: `scripts/build-skill-md.ts` and
 * `scripts/check-skill-sources.ts` import it at CI time, so it must not drag
 * in the seeder's `src/be/db` dependency chain.
 */

export type SkillTemplateConfig = {
  name: string;
  description: string;
  runAllSeedersCandidate?: boolean;
  systemDefault?: boolean;
  /** `false` renders `user-invocable: false` frontmatter (skill is model-invoked only). */
  userInvocable?: boolean;
};

export function buildSkillContent(config: SkillTemplateConfig, body: string): string {
  const userInvocable = config.userInvocable === false ? "\nuser-invocable: false" : "";
  return `---\nname: ${config.name}\ndescription: ${config.description}${userInvocable}\n---\n\n${body.trim()}\n`;
}
