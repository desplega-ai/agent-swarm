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
 * Plain scalars a YAML parser resolves as something other than a string:
 * booleans (YAML 1.1 spellings included — parsers disagree), null, numbers in
 * every base, infinities/NaN, and timestamps. These carry no hostile
 * characters, so the syntax test below passes them through untouched — and
 * `description: true` then reaches a harness as the boolean `true`.
 */
const YAML_IMPLICIT_NON_STRING =
  /^(?:~|null|true|false|yes|no|on|off|[-+]?(?:0b[01_]+|0o[0-7_]+|0x[0-9a-f_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:e[-+]?[0-9]+)?|\.[0-9][0-9_]*(?:e[-+]?[0-9]+)?)|[-+]?\.(?:inf|nan)|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[t ].*)?)$/i;

/**
 * Render a frontmatter value as a YAML scalar. Values that would break a plain
 * scalar (`: `, ` #`, leading indicator chars, tabs/newlines, edge whitespace)
 * or would resolve as a non-string are emitted as JSON-style double-quoted
 * scalars — valid YAML that strict parsers (harness frontmatter readers use
 * js-yaml) accept. Plain-safe values stay raw so existing seeded-skill hashes
 * remain byte-stable.
 */
function yamlScalar(value: string): string {
  const unsafe =
    value === "" ||
    /(: )|(:$)|( #)|[\n\t]|^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$/.test(value) ||
    YAML_IMPLICIT_NON_STRING.test(value);
  return unsafe ? JSON.stringify(value) : value;
}

export function buildSkillContent(config: SkillTemplateConfig, body: string): string {
  const userInvocable = config.userInvocable === false ? "\nuser-invocable: false" : "";
  return `---\nname: ${config.name}\ndescription: ${yamlScalar(config.description)}${userInvocable}\n---\n\n${body.trim()}\n`;
}
