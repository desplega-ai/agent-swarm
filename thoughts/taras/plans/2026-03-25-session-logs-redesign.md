---
date: 2026-03-25T14:30:00Z
topic: "Session Log Viewer Redesign"
planner: claude
status: ready
---

# Session Log Viewer Redesign — Implementation Plan

## Overview

Redesign the `SessionLogViewer` component to render session logs with proper markdown formatting and enhanced JSON display. The current viewer renders text blocks as raw `<p>` tags (markdown characters visible) and tool blocks as unformatted `<pre>` JSON. This plan uses `react-markdown` (already installed) for text blocks and the existing `JsonTree` component for structured JSON display in tool blocks, with overall visual polish to match the "Mission Control" design system.

## Current State Analysis

The `SessionLogViewer` at `new-ui/src/components/shared/session-log-viewer.tsx` (365 lines) has four content block renderers:

| Block | Current | Problem |
|-------|---------|---------|
| `TextBlock` | `<p>` with `whitespace-pre-wrap` (line 257) | Markdown visible as raw text |
| `ThinkingBlock` | Collapsible 120-char preview (lines 129-151) | Functional but bland |
| `ToolUseBlock` | Collapsible `<pre>` with JSON.stringify (lines 154-179) | No syntax colors, hard to scan |
| `ToolResultBlock` | Collapsible `<pre>` with JSON pretty-print (lines 182-216) | Walls of unformatted text |

### Key Discoveries:
- `react-markdown` ^10.1.0 + `remark-gfm` ^4.0.1 already installed, used in chat page (`pages/chat/page.tsx:343`)
- `.prose-chat` CSS class exists in `globals.css:125-213` — comprehensive markdown styling
- `JsonTree` component exists at `components/workflows/json-tree.tsx` — recursive, color-coded, depth-expandable tree with collapsible nodes
- No syntax highlighting library in the project (no shiki, prism, highlight.js)
- No AI Elements installed (`components/ai-elements/` doesn't exist)
- All collapsibles are hand-rolled with `useState` + `ChevronDown/Right`
- `CollapsibleCard` exists locally in task detail page (lines 181-218) but isn't shared

## Desired End State

- **Text blocks**: Rendered with full markdown support (headers, bold, code, lists, tables, links)
- **Tool use blocks**: Collapsible with color-coded JSON tree (expandable/collapsible nodes)
- **Tool result blocks**: Collapsible with better formatting — markdown for text results, pretty JSON for JSON results
- **Thinking blocks**: Refined visual treatment with accent border and better typography
- **Overall**: Tighter spacing, better visual hierarchy between roles, polished "Mission Control" aesthetic

### Verification:
- Open a task with session logs in the dashboard
- Text blocks should render markdown (headers, `**bold**`, `` `code` ``, lists)
- Tool blocks should show color-coded JSON with expandable nodes
- No regressions in auto-scroll behavior or iteration dividers

## Quick Verification Reference

Common commands:
- `cd new-ui && pnpm lint` — Biome check
- `cd new-ui && pnpm exec tsc --noEmit` — TypeScript check
- `cd new-ui && pnpm dev` — Dev server for manual testing

Key files:
- `src/components/shared/session-log-viewer.tsx` — Primary implementation file
- `src/styles/globals.css` — CSS for `.prose-chat` and new session log styles
- `src/components/workflows/json-tree.tsx` — Existing JsonTree component (may need minor adjustments)

## What We're NOT Doing

- **Not installing AI Elements** — The Shiki dynamic rendering bug (Issue #253) poses risk with 5s polling, and we already have `react-markdown` + `JsonTree` in the project. AI Elements can be explored in a future iteration.
- **Not adding syntax highlighting for code blocks** — Would require adding shiki/prism as a dependency. The `.prose-chat` styles already handle `<pre><code>` blocks adequately for agent output.
- **Not changing the parsing logic** — `parseSessionLogs()` stays as-is. We're only changing rendering.
- **Not adding search/filter** — That's a separate feature (Option C from research).
- **Not touching the auto-scroll hook** — It works correctly.

## Implementation Approach

Three phases, each independently verifiable:

1. **Markdown rendering** — Swap `<p>` for `<ReactMarkdown>` in text blocks. Highest visual impact, zero risk.
2. **Enhanced JSON display** — Replace raw `<pre>` in tool blocks with `JsonTree` for inputs and improved formatting for results. Add copy-to-clipboard.
3. **Visual polish** — Refine thinking bubbles, message layout, iteration dividers, and overall spacing.

---

## Phase 1: Markdown Rendering for Text Blocks

### Overview
Replace the raw `<p>` rendering of text blocks with `ReactMarkdown` + `remarkGfm`, using the existing `.prose-chat` CSS class. This is the single highest-impact change — agent responses typically contain headers, bold text, code blocks, and lists that currently display as raw characters.

### Changes Required:

#### 1. Text Block Rendering
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Add imports: `ReactMarkdown` from `react-markdown`, `remarkGfm` from `remark-gfm`
- Replace the text block `<p>` tag (line 257-259) with:
  ```tsx
  <div key={key} className="text-sm text-foreground prose-chat prose-session-log overflow-hidden break-words">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
  </div>
  ```

#### 2. Session-Log-Specific Prose Tweaks
**File**: `src/styles/globals.css`
**Changes**:
- Add a `.prose-session-log` modifier class after the existing `.prose-chat` rules:
  ```css
  /* Session log prose — tighter than chat */
  .prose-session-log {
    font-size: 0.8rem;
    line-height: 1.5;
  }
  .prose-session-log pre {
    max-height: 24rem;
  }
  ```
- Use `prose-chat prose-session-log` as the combined class so we inherit all `.prose-chat` rules but override size.

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Open a task with session logs containing markdown (headers, bold, code blocks, lists)
- [ ] Verify markdown renders properly — headers are styled, `**bold**` shows bold, code blocks have muted background
- [ ] Verify inline code (backticks) renders with the `.prose-chat code` styling (muted bg, Space Mono font)
- [ ] Verify auto-scroll still works — new logs scroll into view
- [ ] Verify "Follow" button appears when scrolling up
- [ ] No visual regressions in tool use, tool result, or thinking blocks

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Enhanced Tool Block Display

### Overview
Replace raw `<pre>` JSON in tool blocks with the existing `JsonTree` component for structured inputs, and improve tool result display with content-aware formatting. Add copy-to-clipboard functionality to both.

### Changes Required:

#### 1. ToolUseBubble — Use JsonTree for Input
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Import `JsonTree` from `@/components/workflows/json-tree`
- Replace the raw `<pre>` in `ToolUseBubble` (lines 173-176) with `JsonTree` when input is an object/array:
  ```tsx
  {open && (
    typeof input === "object" && input !== null ? (
      <JsonTree data={input} defaultExpandDepth={2} maxHeight="192px" className="mt-2" />
    ) : (
      <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-all overflow-auto max-h-48">
        {inputStr}
      </pre>
    )
  )}
  ```
- `JsonTree` has built-in `maxHeight` prop (default `"300px"`) and `className` — use them instead of wrapping in a div
- This gives color-coded keys/values and expandable nested objects

#### 2. ToolResultBubble — Content-Aware Formatting
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Detect content type and render accordingly:
  - JSON object/array results → `JsonTree` with `defaultExpandDepth={1}` and `maxHeight="256px"`
  - Non-JSON text results → keep as `<pre>` with improved styling (do NOT use ReactMarkdown — tool results often contain line-numbered source code like `1→import { verifyToken }...` that markdown would mangle)
- Keep the collapsible behavior with improved preview:
  - **Collapsed**: show first 3 lines (not 200 chars) for text, or key count summary for JSON (e.g., "{ 3 keys }")
  - **Expanded**: full content with appropriate renderer
- Implementation approach:
  ```tsx
  const parsedJson = useMemo(() => {
    try {
      const parsed = JSON.parse(content);
      // Only use JsonTree for objects/arrays, not primitive JSON values
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch { return null; }
  }, [content]);
  ```
- Note: `useMemo` is already imported (line 2), and `useExhaustiveDependencies` lint rule is active for non-ui components

#### 3. Copy Button for Tool Blocks
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Add a small copy-to-clipboard button to the header row of `ToolUseBubble` and `ToolResultBubble`
- Use `navigator.clipboard.writeText()` with a brief "Copied" state (1.5s timeout)
- Icons: `Copy` / `Check` from lucide-react (both already used in `pages/chat/page.tsx`)
- Position: right side of the collapsible header, visible on hover
- **Important**: Clean up the `setTimeout` on unmount to avoid React state-update warnings
- Implementation pattern:
  ```tsx
  function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

    const handleCopy = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      navigator.clipboard.writeText(text);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    }, [text]);

    useEffect(() => {
      return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
    }, []);

    return (
      <button
        type="button"
        onClick={handleCopy}
        className="ml-auto text-muted-foreground/50 hover:text-muted-foreground transition-colors"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    );
  }
  ```
- Note: `useRef`, `useCallback`, and `useEffect` will need to be added to the React import (line 2)

#### 4. JsonTree Compatibility Check
**File**: `src/components/workflows/json-tree.tsx`
**Changes**: None needed — verified:
- Props: `data: unknown`, `defaultExpandDepth?: number` (default `1`), `maxHeight?: string` (default `"300px"`), `className?: string`
- Returns `null` for `undefined`/`null` data (line 18)
- Uses CSS variable classes for chrome (`bg-muted`, `text-muted-foreground`) and hardcoded `dark:` variants for leaf values (`text-emerald-600 dark:text-emerald-400` for strings, `text-amber-600 dark:text-amber-400` for numbers, `text-sky-600 dark:text-sky-400` for booleans) — works in both themes

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Open a task with tool use blocks — JSON inputs show color-coded tree with expandable nodes
- [ ] Open a task with tool result blocks — JSON results show as tree, text results show as markdown
- [ ] Click copy button on a tool block — content is copied to clipboard
- [ ] Verify JsonTree collapsible nodes work (click to expand/collapse individual object keys)
- [ ] Verify max-height scroll works on large tool outputs
- [ ] Verify auto-scroll still works after adding JsonTree
- [ ] Test with both light and dark themes

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Visual Polish

### Overview
Refine the overall visual treatment of the session log viewer — better thinking bubbles, improved message layout, refined iteration dividers, and tighter spacing. This phase brings the component up to "Mission Control" aesthetic standards.

### Changes Required:

#### 1. ThinkingBubble Refinement
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Add a subtle left border accent (amber primary) to visually distinguish thinking:
  ```tsx
  <div className="rounded-md border border-border/50 border-l-2 border-l-primary/40 bg-muted/20 px-3 py-2">
  ```
- Render thinking content with `ReactMarkdown` when expanded (agents sometimes use markdown in thinking)
- Increase preview length from 120 to 200 chars for better context
- Add a `Brain` icon (from lucide) instead of just italic "Thinking..." text

#### 2. ToolUseBubble Header Refinement
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Style the tool name as a monospace badge:
  ```tsx
  <span className="font-mono text-[11px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded">
    {name}
  </span>
  ```
- Makes tool names scannable and consistent with "Mission Control" mono aesthetic

#### 3. Message Layout Refinement
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Remove the circular avatar icons (visual noise in a log context)
- Replace with a subtle left border role indicator:
  - Assistant messages: `border-l-2 border-l-primary/30`
  - User/tool messages: `border-l-2 border-l-muted-foreground/20`
  - System messages: no border, muted background
- Move role label, model, and timestamp into a single compact header line
- Keep model badge but make it less prominent (smaller, lower opacity) — model per-message is useful debugging info not shown elsewhere

#### 4. Iteration Divider Refinement
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Left-aligned label with subtle background tint:
  ```tsx
  <div className="flex items-center gap-3 px-4 py-2 bg-muted/30">
    <span className="text-[10px] font-semibold text-muted-foreground font-mono uppercase tracking-wider">
      Iteration {iteration}
    </span>
    <div className="h-px flex-1 bg-border/50" />
  </div>
  ```

#### 5. Spacing & Typography Pass
**File**: `src/components/shared/session-log-viewer.tsx`
**Changes**:
- Reduce vertical padding on messages from `py-3` to `py-2.5`
- Reduce gap between content blocks from `space-y-2` to `space-y-1.5`
- Consistent `text-sm` for assistant text, `text-xs` for metadata/tool content

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [ ] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Thinking blocks have amber left border accent and Brain icon
- [ ] Tool names display as monospace badges
- [ ] Messages use left-border role indicators instead of avatar circles
- [ ] Iteration dividers are left-aligned with subtle background
- [ ] Overall spacing feels dense but readable — "Mission Control" aesthetic
- [ ] Test in both light and dark themes
- [ ] Auto-scroll still works
- [ ] No layout shifts or overflow issues

**Implementation Note**: After completing this phase, pause for manual confirmation.

### QA Spec (optional):

**Approach:** browser-automation
**Test Scenarios:**
- [ ] TC-1: Markdown text rendering
  - Steps: 1. Navigate to task detail page with session logs, 2. Find an assistant message with markdown content, 3. Verify headings, bold, code blocks render properly
  - Expected: Markdown is rendered with proper formatting (not raw characters)
- [ ] TC-2: Tool input JSON tree
  - Steps: 1. Find a tool use block, 2. Click to expand, 3. Verify color-coded JSON tree appears, 4. Click a nested object to expand/collapse
  - Expected: Interactive JSON tree with colored values, expandable nodes
- [ ] TC-3: Copy button
  - Steps: 1. Hover over a tool block, 2. Click copy button, 3. Paste clipboard content
  - Expected: Full JSON/text content is in clipboard
- [ ] TC-4: Theme toggle
  - Steps: 1. View session logs in dark mode, 2. Switch to light mode, 3. Check all elements
  - Expected: All colors, borders, backgrounds adapt correctly

---

## Testing Strategy

- **Automated**: TypeScript compilation + Biome linting after each phase
- **Manual**: Visual verification in the dashboard with real session log data
- **Themes**: Test both dark and light mode after Phase 3
- **Edge cases**: Empty logs, very long text blocks, deeply nested JSON, non-JSON tool results, system messages

## Manual E2E Verification

After all phases complete, use the seeding script to populate the DB with realistic session log data:

```bash
# 1. Seed the database with demo data (includes session logs with markdown, tool calls, thinking)
cd /Users/taras/Documents/code/agent-swarm && bun run seed --clean

# 2. Start the API server
bun run start:http &

# 3. Start the UI dev server
cd new-ui && pnpm dev

# 4. Open the dashboard and navigate to any task with session logs
# Verify:
#   - Text blocks render markdown (numbered lists, `backtick code`, **bold**)
#   - Tool inputs show color-coded JsonTree (expand/collapse nodes)
#   - Tool results show JsonTree (JSON) or markdown (text like file contents)
#   - Copy buttons work on tool blocks
#   - Thinking blocks have amber accent and Brain icon
#   - Messages use left-border indicators instead of avatar circles
#   - Iteration dividers are left-aligned with background tint
#   - Auto-scroll works with Follow button
#   - Both dark and light themes work
```

The seed script (`scripts/seed.ts`) generates realistic multi-turn conversations with tool calls (Read, Edit, Grep, Bash), thinking blocks, and markdown-rich assistant responses — ideal for testing all the rendering improvements.

## References

- Research document: `/tmp/2026-03-25-1400-session-logs-redesign.md`
- AI Elements investigation: Web research completed — decision was to defer AI Elements in favor of existing project dependencies
- Existing patterns: `JsonTree` at `components/workflows/json-tree.tsx`, `ReactMarkdown` usage at `pages/chat/page.tsx:343`

---

## Review Errata

_Reviewed: 2026-03-25 by Claude_

### Resolved
- [x] **Tool result markdown mangling** — Original plan used ReactMarkdown for non-JSON tool results, but tool results often contain line-numbered source code (`1→import...`) that markdown would mangle. Fixed: keep `<pre>` for non-JSON text results.
- [x] **CopyButton setTimeout cleanup** — Original had no cleanup on unmount. Fixed: added `useRef` + `useEffect` cleanup pattern.
- [x] **Collapsed preview behavior** — Original didn't address how collapsed state works with JsonTree. Fixed: specified 3-line preview for text, key count summary for JSON.
- [x] **Model badge removal** — Original removed model badge entirely, but model-per-message is debugging info not shown elsewhere. Fixed: keep badge with reduced prominence.
- [x] **JsonTree props** — Original didn't mention `maxHeight` and `className` props. Fixed: use built-in props instead of wrapping div.
- [x] **Missing `planner` frontmatter** — Added.
- [x] **React import additions** — Noted that `useCallback` and `useEffect` need to be added to the React import line for CopyButton.
