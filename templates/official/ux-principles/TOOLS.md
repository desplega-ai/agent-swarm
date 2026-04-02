# TOOLS.md — {{agent.name}}

## Repos

- **desplega.ai**: Dashboard at `new-fe/` — React 19, MUI v7, Vite 6, Biome + ESLint, Clerk auth
- **landing**: Marketing site — Next.js 16, shadcn/ui (default), Tailwind v3, Framer Motion
- **landing-labs**: Labs page — Next.js 16, shadcn/ui (new-york), Tailwind v4

## Analysis Tool Configs

### react-scanner (dashboard)

```js
module.exports = {
  crawlFrom: './src',
  includeSubComponents: true,
  importedFrom: /@mui\/material|@mui\/icons-material/,
  processors: ['count-components-and-props']
};
```

### react-scanner (landing / labs)

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
- `dashboard-audit.md` — Latest dashboard analysis
- `landing-audit.md` — Latest landing analysis
- `cross-project-audit.md` — Cross-project consistency findings

## Linear

- Project for UX tickets: `ux2.0`
- Use the `linear-interaction` skill to create issues and add comments

## Visual Verification

- Use qa-use MCP for browser control
- Screenshot at 3 viewports: 375px (mobile), 768px (tablet), 1440px (desktop)
- Feed screenshots to Claude Vision for evaluation

---
*This file is yours. Update it as you discover your environment. Changes persist across sessions.*
