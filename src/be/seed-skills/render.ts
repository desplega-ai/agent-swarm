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

/**
 * Render a frontmatter value as a YAML scalar. Values that would break a plain
 * scalar (`: `, ` #`, leading indicator chars, tabs/newlines, edge whitespace)
 * are emitted as JSON-style double-quoted scalars — valid YAML that strict
 * parsers (harness frontmatter readers use js-yaml) accept. Plain-safe values
 * stay raw so existing seeded-skill hashes remain byte-stable.
 */
function yamlScalar(value: string): string {
  const unsafe = /(: )|(:$)|( #)|[\n\t]|^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$/.test(value);
  return unsafe ? JSON.stringify(value) : value;
}

export function buildSkillContent(config: SkillTemplateConfig, body: string): string {
  const userInvocable = config.userInvocable === false ? "\nuser-invocable: false" : "";
  return `---\nname: ${config.name}\ndescription: ${yamlScalar(config.description)}${userInvocable}\n---\n\n${body.trim()}\n`;
}
