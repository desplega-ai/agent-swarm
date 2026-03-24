/**
 * Build pi-mono SKILL.md files from claude command sources.
 *
 * Source of truth: plugin/commands/*.md
 * Output: plugin/pi-skills/<name>/SKILL.md
 *
 * Only commands listed in SKILLS_TO_CONVERT are converted.
 * Provider-specific sections use markers:
 *   <!-- claude-only -->...<!-- /claude-only -->  → stripped for pi-mono
 *   <!-- pi-only -->...<!-- /pi-only -->          → stripped for claude (kept for pi-mono)
 *
 * Usage: bun run plugin/build-pi-skills.ts
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const COMMANDS_DIR = join(import.meta.dir, "commands");
const PI_SKILLS_DIR = join(import.meta.dir, "pi-skills");

/** All commands to convert to pi-mono skills */
const SKILLS_TO_CONVERT = [
  "work-on-task",
  "start-worker",
  "start-leader",
  "swarm-chat",
  "close-issue",
  "create-pr",
  "implement-issue",
  "investigate-sentry-issue",
  "respond-github",
  "review-offered-task",
  "review-pr",
  "todos",
];

function convertToPiSkill(name: string, content: string): string {
  let result = content;

  // 1. Strip <!-- claude-only --> sections
  result = result.replace(/<!-- claude-only -->\n?[\s\S]*?<!-- \/claude-only -->\n?/g, "");

  // 2. Reveal <!-- pi-only --> sections (remove markers, keep content)
  result = result.replace(/<!-- pi-only -->\n?/g, "");
  result = result.replace(/<!-- \/pi-only -->\n?/g, "");

  // 3. Convert frontmatter: extract description, drop argument-hint, add name
  result = result.replace(/^---\n([\s\S]*?)---\n/, (_match, frontmatter: string) => {
    const descMatch = frontmatter.match(/description:\s*(.+)/);
    const description = descMatch ? descMatch[1].trim() : name;
    return `---\nname: ${name}\ndescription: ${description}\n---\n`;
  });

  // 4. Slash command syntax: /command-name → /skill:command-name
  //    Match ` /name` or `/name` at word boundary, but not /desplega: or /workspace
  for (const skillName of SKILLS_TO_CONVERT) {
    // In backticks or after whitespace/start-of-line
    result = result.replace(
      new RegExp(`(\`|\\s|^)\\/${skillName}(?=\\s|\`|$)`, "gm"),
      `$1/skill:${skillName}`,
    );
  }

  // 5. /desplega:* commands → generic descriptions
  //    Replace the "Available commands" section pattern
  result = result.replace(
    /### Available commands[\s\S]*?(?=\n### [^#]|\n## |$)/,
    `### Research and Planning

As you start working on a task, consider whether you need to:

- **Research**: For research tasks, gather information from the web, codebase, or documentation before starting implementation.
- **Create a plan**: For development tasks, create a detailed plan before implementing. Write it to \`/workspace/personal/plans/\`.
- **Implement a plan**: If you already have a plan, follow it step by step.

### Communication

- Use \`/skill:swarm-chat\` to communicate with other agents in the swarm if you need help or want to provide updates.

#### Decision guidelines

When the task is a research task, you should ALWAYS perform thorough research before proceeding.

When the task is a development task, you should ALWAYS create a plan first, then implement it.

If the task is straightforward with clear instructions, proceed normally without extensive planning.

`,
  );

  // Remove the old "Decision to use commands" subsection if it survived
  result = result.replace(/#### Decision to use commands[\s\S]*?(?=### |## |$)/, "");

  // Clean up any remaining /desplega: references that weren't in a block
  result = result.replace(
    /- `\/desplega:research`[^\n]*\n/g,
    "- Research - Workers can perform research on the web to gather information needed for the task\n",
  );
  result = result.replace(
    /- `\/desplega:create-plan`[^\n]*\n/g,
    "- Planning - Workers can create a detailed plan for how they will approach and complete the task\n",
  );
  result = result.replace(
    /- `\/desplega:implement-plan`[^\n]*\n/g,
    "- Implementation - Workers can implement a plan step by step\n",
  );

  // 6. Replace /desplega:* inline references
  result = result.replace(/`\/desplega:research`/g, "research");
  result = result.replace(/`\/desplega:create-plan`/g, "plan creation");
  result = result.replace(/`\/desplega:implement-plan`/g, "plan implementation");
  result = result.replace(/\/desplega:research/g, "research");
  result = result.replace(/\/desplega:create-plan/g, "plan creation");
  result = result.replace(/\/desplega:implement-plan/g, "plan implementation");

  // 7. /todos references — now converted to /skill:todos by step 4
  //    Just clean up backtick formatting around the converted refs
  result = result.replace(/`\/todos`/g, "`/skill:todos`");

  // 8. Clean up "the `/skill:swarm-chat` command" → "`/skill:swarm-chat`"
  //    At this point step 4 already converted /swarm-chat → /skill:swarm-chat
  result = result.replace(/Use the (`\/skill:swarm-chat`)/g, "Use $1");
  result = result.replace(/the (`\/skill:swarm-chat`) command/g, "$1");
  result = result.replace(/the (`\/skill:swarm-chat`) channel/g, "$1 channel");
  result = result.replace(/(`\/skill:swarm-chat`) command/g, "$1");

  // 9. Setup message simplification
  result = result.replace(
    / Please run `bunx @desplega\.ai\/agent-swarm setup` to configure it\./g,
    "",
  );

  // 10. "the command `/skill:..." → "`/skill:..." and "this command" → "this skill"
  result = result.replace(/the command (`\/skill:[^`]+`)/g, "$1");
  result = result.replace(/call the (`\/skill:[^`]+`)/g, "call $1");
  result = result.replace(/this command is used/gi, "this skill is used");
  result = result.replace(/If this command/gi, "If this skill");

  // 11. Wording: "command" → "skill" for worker sections and general references
  result = result.replace(/#### Worker available commands/g, "#### Worker available skills");
  result = result.replace(/the following commands to help/g, "the following skills to help");
  // "use `/skill:swarm-chat` command" → "use `/skill:swarm-chat`"
  result = result.replace(/(`\/skill:[^`]+`) command/g, "$1");
  // "without using any commands" → "without extensive planning"
  result = result.replace(
    /proceed normally to implement it without using any commands/g,
    "proceed normally without extensive planning",
  );

  // 13. Soften "available commands" wording
  result = result.replace(
    /Figure out if you need to use any of the available commands to help you with your work \(see below for available commands\)/g,
    "Figure out if you need to perform any research or planning before starting (see below)",
  );

  // 14. Remove emoji (😈) since pi-mono doesn't use them
  result = result.replace(/\n😈\n/g, "\n");

  // 14. Fix step numbering — renumber sequential list items starting from 1
  //     After removing claude-only sections, step numbers may have gaps
  const lines = result.split("\n");
  let stepCounter = 0;
  let inNumberedList = false;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\d+)\. /);
    if (match) {
      if (!inNumberedList) {
        stepCounter = 1;
        inNumberedList = true;
      } else {
        stepCounter++;
      }
      lines[i] = lines[i].replace(/^\d+\. /, `${stepCounter}. `);
    } else if (!/^\s/.test(lines[i]) && lines[i].trim() !== "") {
      inNumberedList = false;
      stepCounter = 0;
    }
  }
  result = lines.join("\n");

  // 15. Trim trailing whitespace from lines
  result = result
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");

  // 16. Clean up multiple consecutive blank lines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}

// Main
const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
let converted = 0;

for (const file of files) {
  const name = file.replace(".md", "");
  if (!SKILLS_TO_CONVERT.includes(name)) continue;

  const content = readFileSync(join(COMMANDS_DIR, file), "utf-8");
  const piContent = convertToPiSkill(name, content);

  const outDir = join(PI_SKILLS_DIR, name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "SKILL.md"), piContent);

  converted++;
  console.log(`✓ ${name}`);
}

console.log(`\nConverted ${converted} skills to pi-mono format.`);
