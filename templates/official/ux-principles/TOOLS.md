# TOOLS.md — {{agent.name}}

## Repos

<!-- Replace with your actual repositories and their tech stacks -->
- **[Repository 1]**: Main app/dashboard — e.g., React, MUI, Vite, your preferred linter + auth solution
- **[Repository 2]**: Marketing site — e.g., Next.js, shadcn/ui, Tailwind CSS, Framer Motion
- **[Repository 3]**: Secondary site/labs — e.g., Next.js, shadcn/ui, Tailwind CSS

## Analysis Tool Configs

### react-scanner ([Repository 1])

```js
module.exports = {
  crawlFrom: './src',
  includeSubComponents: true,
  // Adjust the importedFrom regex to match your component library
  importedFrom: /@mui\/material|@mui\/icons-material/,
  processors: ['count-components-and-props']
};
```

### react-scanner ([Repository 2] / [Repository 3])

```js
module.exports = {
  crawlFrom: './src',
  includeSubComponents: true,
  processors: ['count-components-and-props']
};
```

## Principles Storage

agent-fs shared drive: `thoughts/{your-agent-id}/ux-principles/`

- `principles.md` — Living document (single source of truth)
- `repo1-audit.md` — Latest [Repository 1] analysis
- `repo2-audit.md` — Latest [Repository 2] analysis
- `cross-project-audit.md` — Cross-project consistency findings

## Project Tracker

<!-- Replace with your project tracker details -->
- Project for UX tickets: `[project-name]` in [project tracker] (e.g., Linear, Jira, GitHub Issues)
- Use the appropriate skill or API to create issues and add comments

## Visual Verification

- Use qa-use MCP for browser control
- Screenshot at 3 viewports: 375px (mobile), 768px (tablet), 1440px (desktop)
- Feed screenshots to Claude Vision for evaluation

---
*This file is yours. Update it as you discover your environment. Changes persist across sessions.*
