# Mobile Responsive UI Implementation Plan

## Overview

Make the agent-swarm dashboard fully responsive on mobile devices (320px-480px) and tablets (768px-1024px) while preserving the existing desktop experience.

## Current State Analysis

- **Framework**: MUI Joy UI with custom CSS
- **Layout**: Tabbed master-detail pattern assuming wide viewport
- **Styling**: Custom "beehive" theme with amber/gold colors, glow effects
- **Issue**: No mobile responsiveness - fixed flex layouts, hardcoded widths, no breakpoints

### Key Discoveries:
- Dashboard uses `display: flex` with fixed `gap: 3` (24px) horizontal layouts
- Detail panels have fixed widths: AgentDetailPanel 400px, TaskDetailPanel 450px
- Tables with 5-8 columns unusable on mobile
- ChatPanel channel list fixed at `width: 220`
- Padding throughout uses `px: 3` (24px) - too large for mobile
- No media queries or responsive breakpoints defined

## Desired End State

1. App fully usable on mobile phones (320px-480px width)
2. Tablet experience optimized (768px-1024px)
3. Desktop experience unchanged
4. Beehive theme aesthetic maintained across all breakpoints

### Verification:
- Open app in Chrome DevTools mobile view (iPhone SE, Pixel 5)
- All tabs accessible and functional
- Detail panels usable without horizontal scroll
- Touch targets minimum 44x44px

## What We're NOT Doing

- **Changing component structure** - Keep existing component hierarchy
- **Adding new tabs/pages** - ActivityFeed hidden on mobile, not moved to tab
- **Breaking desktop layout** - All changes use responsive breakpoints
- **Redesigning visual theme** - Colors, glows, hexagons stay the same

## Implementation Approach

Mobile-first responsive design using MUI Joy's `sx` prop with breakpoint objects (e.g., `{ xs: value, md: value, lg: value }`).

**Breakpoints** (MUI defaults):
- `xs`: 0-599px (phones)
- `sm`: 600-899px (small tablets)
- `md`: 900-1199px (tablets)
- `lg`: 1200px+ (desktop - current behavior preserved)

---

## Phase 1: Dashboard Core Layout

### Overview
Update the main Dashboard layout to stack vertically on mobile and handle detail panels as overlays.

### Changes Required:

#### 1. Dashboard.tsx

**Responsive padding** (line ~294):
```tsx
sx={{
  px: { xs: 1.5, sm: 2, md: 3 },  // was: px: 3
  pt: { xs: 1.5, md: 2 },
  pb: { xs: 2, md: 3 },
}}
```

**Scrollable tabs** (line ~307-343):
```tsx
<TabList sx={{
  overflowX: { xs: "auto", md: "visible" },
  flexWrap: { xs: "nowrap", md: "wrap" },
  "& .MuiTab-root": {
    px: { xs: 2, md: 3 },
    fontSize: { xs: "0.7rem", md: "0.8rem" },
  },
}}/>
```

**Master-detail stack on mobile** (line ~358):
```tsx
<Box sx={{
  flexDirection: { xs: "column", lg: "row" },
  gap: { xs: 2, md: 3 },
}}>
```

**Hide master panel when detail selected on mobile**:
```tsx
<Box sx={{
  display: {
    xs: selectedAgentId ? "none" : "flex",
    md: "flex"
  },
}}>
```

**Hide ActivityFeed on mobile**:
```tsx
<Box sx={{
  display: { xs: "none", lg: "block" }
}}>
  <ActivityFeed />
</Box>
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc` passes with no type errors
- [ ] App renders without console errors in mobile viewport

#### Manual Verification:
- [ ] Tabs scroll horizontally on mobile
- [ ] Master panel hides when detail selected on mobile
- [ ] ActivityFeed hidden on screens < 1200px

---

## Phase 2: Header Component

### Overview
Reduce header padding and title size on mobile.

### Changes Required:

#### Header.tsx

**Responsive padding** (line ~48):
```tsx
<Box sx={{
  px: { xs: 1.5, sm: 2, md: 3 },
  py: { xs: 1.5, md: 2 },
}}>
```

**Responsive title** (line ~62):
```tsx
<Typography sx={{
  fontSize: { xs: "1.1rem", sm: "1.25rem", md: "1.5rem" },
  letterSpacing: { xs: "0.1em", md: "0.15em" },
}}>
  <Box component="span" sx={{ display: { xs: "none", sm: "inline" } }}>
    AGENT SWARM
  </Box>
  <Box component="span" sx={{ display: { xs: "inline", sm: "none" } }}>
    SWARM
  </Box>
</Typography>
```

**Reduce button gap**:
```tsx
<Box sx={{ gap: { xs: 0.75, md: 1.5 } }}>
```

### Success Criteria:

#### Manual Verification:
- [ ] Header fits on 320px viewport without overflow
- [ ] Title shows "SWARM" on mobile, "AGENT SWARM" on desktop

---

## Phase 3: Detail Panels - Full Screen Mobile Overlay

### Overview
Convert AgentDetailPanel and TaskDetailPanel to full-screen overlays on mobile.

### Changes Required:

#### AgentDetailPanel.tsx

**Full screen on mobile** (line ~382):
```tsx
<Box sx={{
  position: { xs: "fixed", md: "relative" },
  inset: { xs: 0, md: "auto" },
  zIndex: { xs: 1300, md: "auto" },
  width: { xs: "100%", md: expanded ? "100%" : 400 },
  height: { xs: "100%", md: "100%" },
  borderRadius: { xs: 0, md: "12px" },
}}>
```

**Add mobile back button**:
```tsx
<IconButton
  sx={{ display: { xs: "flex", md: "none" } }}
  onClick={onClose}
>
  <ArrowLeftIcon />
</IconButton>
```

**Reduce padding**:
```tsx
<Box sx={{ p: { xs: 1.5, md: 2 } }}>
```

#### TaskDetailPanel.tsx

Apply same patterns as AgentDetailPanel.

### Success Criteria:

#### Manual Verification:
- [ ] Detail panels cover full screen on mobile
- [ ] Back button visible and functional on mobile
- [ ] Panels close properly when back button pressed

---

## Phase 4: Agents Panel - Table to Cards

### Overview
Replace table with card-based layout on mobile.

### Changes Required:

#### AgentsPanel.tsx

**Create AgentCard component**:
```tsx
function AgentCard({ agent, selected, onClick }) {
  return (
    <Box onClick={onClick} sx={{
      p: 2,
      mb: 1,
      borderRadius: "8px",
      border: "1px solid",
      borderColor: selected ? colors.amber : "neutral.outlinedBorder",
    }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", mb: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <StatusDot status={agent.status} />
          <Typography fontWeight={600}>{agent.name}</Typography>
          {agent.isLead && <Chip size="sm">LEAD</Chip>}
        </Box>
        <StatusBadge status={agent.status} />
      </Box>
      <Typography fontSize="0.75rem" color="text.tertiary">
        {agent.role || "No role"} · {activeTasks}/{agent.tasks.length} tasks
      </Typography>
    </Box>
  );
}
```

**Responsive filters**:
```tsx
<Box sx={{
  flexDirection: { xs: "column", sm: "row" },
  alignItems: { xs: "stretch", sm: "center" },
}}>
  <Input sx={{ minWidth: { xs: "100%", sm: 140 } }} />
  <Select sx={{ minWidth: { xs: "100%", sm: 100 } }} />
</Box>
```

**Conditional table/cards**:
```tsx
{/* Desktop Table */}
<Box sx={{ display: { xs: "none", md: "block" } }}>
  <Table>...</Table>
</Box>

{/* Mobile Cards */}
<Box sx={{ display: { xs: "block", md: "none" }, p: 2 }}>
  {filteredAgents.map(agent => <AgentCard key={agent.id} agent={agent} />)}
</Box>
```

### Success Criteria:

#### Manual Verification:
- [ ] Cards display on mobile, table on desktop
- [ ] Filters stack vertically on mobile
- [ ] Card tap selects agent correctly

---

## Phase 5: Tasks Panel - Table to Cards

### Overview
Same card-based approach as AgentsPanel.

### Changes Required:

#### TasksPanel.tsx

**Create TaskCard component**:
```tsx
function TaskCard({ task, selected, onClick, agentName }) {
  return (
    <Box onClick={onClick} sx={{ p: 2, mb: 1, borderRadius: "8px", border: "1px solid" }}>
      <Typography sx={{ fontWeight: 600, mb: 1 }} noWrap>
        {task.task}
      </Typography>
      <Box sx={{ display: "flex", justifyContent: "space-between" }}>
        <StatusBadge status={task.status} />
        <Typography fontSize="0.75rem">{getElapsedTime(task)}</Typography>
      </Box>
      {task.agentId && (
        <Typography fontSize="0.75rem" mt={0.5}>Agent: {agentName}</Typography>
      )}
    </Box>
  );
}
```

**Apply same conditional rendering as AgentsPanel**

### Success Criteria:

#### Manual Verification:
- [ ] Task cards display on mobile
- [ ] Status and timing visible on cards
- [ ] Agent name shown when assigned

---

## Phase 6: Chat Panel - Drawer Sidebar

### Overview
Convert channel list to drawer on mobile.

### Changes Required:

#### ChatPanel.tsx

**Add drawer state**:
```tsx
const [channelDrawerOpen, setChannelDrawerOpen] = useState(false);
```

**Mobile drawer for channels**:
```tsx
<Drawer
  open={channelDrawerOpen}
  onClose={() => setChannelDrawerOpen(false)}
  sx={{ display: { xs: "block", md: "none" } }}
>
  {/* Channel list content */}
</Drawer>
```

**Desktop permanent sidebar**:
```tsx
<Box sx={{
  width: 220,
  display: { xs: "none", md: "flex" },
}}>
  {/* Channel list content */}
</Box>
```

**Mobile hamburger button**:
```tsx
<IconButton
  sx={{ display: { xs: "flex", md: "none" } }}
  onClick={() => setChannelDrawerOpen(true)}
>
  <MenuIcon />
</IconButton>
```

**Thread panel overlay on mobile**:
```tsx
{selectedThreadMessage && (
  <Box sx={{
    position: { xs: "fixed", md: "relative" },
    inset: { xs: 0, md: "auto" },
    zIndex: { xs: 1300, md: "auto" },
  }}>
```

### Success Criteria:

#### Manual Verification:
- [ ] Channel list opens as drawer on mobile
- [ ] Hamburger menu button visible on mobile
- [ ] Thread view covers full screen on mobile

---

## Phase 7: StatsBar - Compact Mobile Layout

### Overview
Reduce hexagon sizes and enable horizontal scroll on mobile.

### Changes Required:

#### StatsBar.tsx

**Smaller hexagons**:
```tsx
<Box sx={{
  width: { xs: 65, sm: 75, md: 90 },
  height: { xs: 72, sm: 84, md: 100 },
}}>
```

**Smaller value text**:
```tsx
<Typography sx={{
  fontSize: { xs: "1.1rem", md: "1.5rem" },
}}>
```

**Horizontal scroll container**:
```tsx
<Box sx={{
  flexDirection: { xs: "row", md: "column" },
  overflowX: { xs: "auto", md: "visible" },
  gap: { xs: 1, md: 0 },
}}>
```

### Success Criteria:

#### Manual Verification:
- [ ] Stats fit on mobile screen
- [ ] Horizontal scroll works on mobile
- [ ] Values readable on small screens

---

## Phase 8: Touch Target Sizing

### Overview
Ensure all interactive elements meet 44x44px minimum tap target.

### Changes Required:

Apply to all IconButtons and clickable elements:
```tsx
sx={{
  minWidth: { xs: 44, md: "auto" },
  minHeight: { xs: 44, md: "auto" },
}}
```

### Files to update:
- Header.tsx (theme toggle, settings button)
- AgentsPanel.tsx (refresh button)
- TasksPanel.tsx (filter dropdowns)
- ChatPanel.tsx (send button, menu buttons)
- All detail panels (close/expand buttons)

### Success Criteria:

#### Manual Verification:
- [ ] All buttons tappable without precision
- [ ] No overlapping tap targets

---

## Testing Strategy

### Device Testing:
1. Chrome DevTools responsive mode
2. iPhone SE (320px) - smallest viewport
3. iPhone 14 (390px) - common phone
4. iPad Mini (768px) - small tablet
5. iPad (1024px) - tablet

### Manual Testing Steps:
1. Navigate all tabs on each viewport
2. Select and view agent/task details
3. Use chat with channel switching
4. Verify all buttons tappable
5. Check for horizontal overflow

---

## Files Summary

| File | Priority | Changes |
|------|----------|---------|
| `ui/src/components/Dashboard.tsx` | 1 | Layout orchestration |
| `ui/src/components/Header.tsx` | 2 | Padding/sizing |
| `ui/src/components/AgentDetailPanel.tsx` | 3 | Full-screen overlay |
| `ui/src/components/TaskDetailPanel.tsx` | 3 | Full-screen overlay |
| `ui/src/components/AgentsPanel.tsx` | 4 | Table-to-cards |
| `ui/src/components/TasksPanel.tsx` | 4 | Table-to-cards |
| `ui/src/components/ChatPanel.tsx` | 5 | Drawer sidebar |
| `ui/src/components/StatsBar.tsx` | 6 | Compact layout |

---

## References

- MUI Joy breakpoints: Default `xs: 0, sm: 600, md: 900, lg: 1200, xl: 1536`
- MUI sx prop: https://mui.com/system/getting-started/the-sx-prop/
- Touch target guidelines: 44x44px minimum (Apple HIG)
- Current theme: `ui/src/lib/theme.ts`
