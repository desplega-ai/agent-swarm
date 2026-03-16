# Extract Image Generation Prompt

You are a meme content specialist. Your task is to adapt an **EXISTING classic meme template** to create a series-appropriate hero image based on the blog post content.

## Series Context

**Series:** {{series_name}}

### Series Theme Guidance

{{#if_eq series_name "Foundation"}}
**Foundation Series** focuses on QA/QC education and automation tips. Meme themes should relate to:
- Quality assurance, quality control, testing strategies
- Automation workflows, CI/CD pipelines
- Bug detection, debugging techniques
- Test coverage, testing best practices
- Web testing (Playwright, Selenium, Cypress)
- Developer/QA collaboration
{{/if_eq}}

{{#if_eq series_name "Test Wars"}}
**Test Wars Series** focuses on CTO/CEO challenges and business of QA. Meme themes should relate to:
- Business decisions, ROI of testing
- Leadership challenges, executive perspective
- Budget constraints vs quality demands
- Team dynamics, hiring decisions
- Product launch pressure vs stability
- Satirical take on business realities
{{/if_eq}}

{{#if_eq series_name "Vibe"}}
**Vibe Series** focuses on vibecoding and building engaging apps. Meme themes should relate to:
- Solopreneur journey, indie hacking
- Fast shipping, rapid prototyping
- Modern tool adoption, new frameworks
- Engaging UX/UI, user delight
- Building in public, community
- Energy, momentum, productivity
{{/if_eq}}

{{#if_eq series_name "Level Up"}}
**Level Up Series** focuses on tool-to-tool migration guides. Meme themes should relate to:
- Tool migration, switching platforms
- Learning curves, skill progression
- Before/after comparisons
- Overcoming intimidation, gaining confidence
- Professional development journey
- Transitions from vibe tools to pro tools
{{/if_eq}}

## Blog Content

{{blog_content}}

## Recent Prompts - CRITICAL: Check for Forbidden Templates

{{recent_prompts}}

**MANDATORY TEMPLATE DIVERSITY RULE:**
- If a template appears in the "FORBIDDEN TEMPLATES" section above, you MUST use a different template
- Choose from templates NOT used in the last 10 days
- Variety is more important than "perfect fit" - pick something fresh

## Recommended Meme Template Category for This Post

**Template Category:** {{style_category}}

**Category Description:** {{style_description}}

**Template Examples:** {{style_keywords}}

**CRITICAL:** Use an EXISTING, RECOGNIZABLE meme template from this category. DO NOT create new meme formats.

## Your Task

Create a detailed image generation prompt (2-3 sentences maximum) that uses a **classic meme template** adapted to the blog's series theme.

**CRITICAL REQUIREMENTS:**
1. **Use EXISTING meme templates ONLY** - Reference well-known, classic internet memes
2. **Check recent prompts above** - DO NOT reuse the same meme template from recent posts
3. **Follow the recommended category** - But choose a specific meme template from that category
4. **Adapt to series theme** - The meme should relate to the series focus (see Series Theme Guidance above)
5. **Keep it recognizable** - Someone should be able to identify which classic meme format you're using

## Meme Template Requirements

The meme template you choose should:
1. **Be a CLASSIC, RECOGNIZABLE meme** - Use well-known internet meme formats that people will recognize
2. **Fit the blog topic and series theme** - Relate to the specific series focus (Foundation/Test Wars/Vibe/Level Up)
3. **Work as a hero image** - Suitable for a 16:9 aspect ratio banner at the top of the blog
4. **Include the original meme context** - Reference the original meme setup/situation
5. **Be professional enough** - Appropriate for a tech company blog (avoid offensive memes)

## Available Meme Templates

**YOU MUST USE ONE OF THESE EXACT TEMPLATE KEYS:**

{{available_templates}}

**CRITICAL: Each template requires a specific number of text boxes. You MUST provide the exact number of text fields (text0, text1, text2, text3) that match the template's box count.**

**Template Descriptions with Box Requirements:**

**1-Box Templates (only text0 required, leave text1/text2/text3 empty):**
- `this_is_fine (1 box)` - Dog in burning room (crisis)
- `success_kid (1 box)` - Fist pump victory
- `stonks (1 box)` - Success going up
- `hide_the_pain_harold (1 box)` - Suppressing frustration
- `change_my_mind (1 box)` - Strong opinion at table
- `disaster_girl (1 box)` - Everything's on fire
- `monkey_puppet (1 box)` - Awkward look away
- `roll_safe (1 box)` - Clever thinking
- `doge (1 box)` - Classic doge
- `wholesome (1 box)` / `keanu (1 box)` - Positive/encouraging

**2-Box Templates (text0 and text1 required, leave text2/text3 empty):**
- `drake (2 boxes)` / `drake_hotline_bling (2 boxes)` - Rejecting vs approving (comparison)
- `two_buttons (2 boxes)` / `sweating_guy (2 boxes)` / `daily_struggle (2 boxes)` - Difficult choice, sweating
- `woman_yelling_at_cat (2 boxes)` - Argument format
- `surprised_pikachu (2 boxes)` - Shocked reaction
- `buff_doge (2 boxes)` - Then vs now strength
- `evil_kermit (2 boxes)` - Internal conflict
- `ancient_aliens (2 boxes)` - Conspiracy theory
- `bad_luck_brian (2 boxes)` - Unfortunate outcome
- `third_world_success (2 boxes)` - Unexpected win

**3-Box Templates (text0, text1, and text2 required, leave text3 empty):**
- `distracted_boyfriend (3 boxes)` - Choosing between alternatives (boyfriend/girlfriend/other woman)
- `left_exit (3 boxes)` - Unexpected exit choice
- `panik_kalm (3 boxes)` - Relief then panic
- `bicycle_fall (3 boxes)` / `bike_fall (3 boxes)` - Blaming wrong thing

**4-Box Templates (text0, text1, text2, and text3 ALL required):**
- `expanding_brain (4 boxes)` / `galaxy_brain (4 boxes)` - Increasingly sophisticated ideas (4 levels)
- `gru_plan (4 boxes)` - Unexpected outcome in presentation (4 panels)

**5+ Box Templates (text0 through text4, may need more):**
- `boardroom_meeting (5 boxes)` - Boss + 3 suggestions + person thrown out window

**CRITICAL RULES:**
1. **Match box count exactly** - If template needs 4 boxes, provide text0, text1, text2, text3
2. **No pipe-separated text** - Do NOT use "Panel1|Panel2|Panel3|Panel4" format
3. **Empty strings for unused** - If template needs 2 boxes, set text2="" and text3=""
4. **One idea per box** - Each text field is one panel's text, keep it short (3-7 words)

**CRITICAL: Only use template keys from the list above. Do NOT invent new template names.**

## Examples of Good Meme Adaptation Prompts

### Foundation Series Examples (QA/Testing Focus)

**Drake Hotline Bling (2 boxes):**
```json
{"template": "drake", "text0": "Manual Testing", "text1": "Automated Test Suite", "text2": "", "text3": ""}
```

**This is Fine (1 box):**
```json
{"template": "this_is_fine", "text0": "Production is on fire", "text1": "", "text2": "", "text3": ""}
```

**Expanding Brain (4 boxes - one idea per box):**
```json
{"template": "expanding_brain", "text0": "Skip Tests", "text1": "Unit Tests", "text2": "Integration Tests", "text3": "E2E Tests"}
```

**Woman Yelling at Cat (2 boxes):**
```json
{"template": "woman_yelling_at_cat", "text0": "QA Team: You broke production!", "text1": "Dev: Not my code", "text2": "", "text3": ""}
```

### Test Wars Series Examples (Business/Leadership Focus)

**Two Buttons (2 boxes):**
```json
{"template": "two_buttons", "text0": "Ship on Time", "text1": "Fix All Bugs", "text2": "", "text3": ""}
```

**Stonks (1 box):**
```json
{"template": "stonks", "text0": "Test Coverage ↗", "text1": "", "text2": "", "text3": ""}
```

**Change My Mind (1 box):**
```json
{"template": "change_my_mind", "text0": "QA Budget is an Investment", "text1": "", "text2": "", "text3": ""}
```

### Vibe Series Examples (Solopreneur/Vibecoding Focus)

**Success Kid (1 box):**
```json
{"template": "success_kid", "text0": "Shipped MVP in 48 Hours", "text1": "", "text2": "", "text3": ""}
```

**Distracted Boyfriend (3 boxes - boyfriend/girlfriend/other):**
```json
{"template": "distracted_boyfriend", "text0": "Solo Dev", "text1": "Current Stack", "text2": "New Shiny Framework", "text3": ""}
```

**Drake Hotline Bling (2 boxes):**
```json
{"template": "drake", "text0": "Complex Setup", "text1": "Vibe Coding with AI", "text2": "", "text3": ""}
```

**Roll Safe (1 box):**
```json
{"template": "roll_safe", "text0": "Can't have tech debt if you ship fast", "text1": "", "text2": "", "text3": ""}
```

### Level Up Series Examples (Migration/Learning Focus)

**Buff Doge (2 boxes - strong vs weak):**
```json
{"template": "buff_doge", "text0": "Me with Lovable: Shipping fast", "text1": "Me learning Cursor: What's Git?", "text2": "", "text3": ""}
```

**Surprised Pikachu (2 boxes):**
```json
{"template": "surprised_pikachu", "text0": "Switches from v0 to Cursor", "text1": "Need to learn Git now", "text2": "", "text3": ""}
```

**Gru's Plan (4 boxes - plan with unexpected twist):**
```json
{"template": "gru_plan", "text0": "Export from Replit", "text1": "Import to Claude Code", "text2": "Keep same velocity", "text3": "Keep same velocity...?"}
```

**Expanding Brain (4 boxes - tool progression):**
```json
{"template": "expanding_brain", "text0": "No-Code Builder", "text1": "Vibe Coding Tool", "text2": "AI-Enhanced IDE", "text3": "Full Pro Setup"}
```

**CRITICAL:** Every example shows explicit text0/text1/text2/text3 fields. Empty strings for unused boxes. NO pipe-separated text!

## Output Format

You MUST return ONLY a JSON object with these exact fields:

```json
{
  "template": "template_key_name",
  "text0": "First box text",
  "text1": "Second box text (or empty string if template has 1 box)",
  "text2": "Third box text (or empty string if template has <3 boxes)",
  "text3": "Fourth box text (or empty string if template has <4 boxes)"
}
```

**CRITICAL REQUIREMENTS:**
1. **Return ONLY the JSON** - No explanation, no commentary, no markdown code blocks
2. **Use exact template keys** - Match the keys from the available_templates list
3. **Provide all 4 text fields** - Always include text0, text1, text2, text3 (use "" for unused)
4. **Match box count** - If template has 2 boxes, set text2="" and text3=""
5. **Keep text concise** - Each box text should be 3-10 words maximum
6. **No pipe separators** - Do NOT use "Panel1|Panel2|Panel3" format

## Box Count Reference Guide

**How to determine box count:**
- Check the available_templates list - it shows "(N boxes)" after each template name
- 1 box = only fill text0, leave text1/text2/text3 empty
- 2 boxes = fill text0 and text1, leave text2/text3 empty
- 3 boxes = fill text0, text1, and text2, leave text3 empty
- 4 boxes = fill all: text0, text1, text2, text3

## Example Outputs by Series and Box Count

### 1-Box Templates
Success Kid (Foundation/Vibe series):
```json
{"template": "success_kid", "text0": "Shipped MVP Today", "text1": "", "text2": "", "text3": ""}
```

Stonks (Test Wars series):
```json
{"template": "stonks", "text0": "Test Coverage ↗", "text1": "", "text2": "", "text3": ""}
```

### 2-Box Templates
Drake (Foundation/Vibe series):
```json
{"template": "drake", "text0": "Manual Testing", "text1": "Automated Tests", "text2": "", "text3": ""}
```

Two Buttons (Test Wars series):
```json
{"template": "two_buttons", "text0": "Ship on Time", "text1": "Fix All Bugs", "text2": "", "text3": ""}
```

Buff Doge (Level Up series):
```json
{"template": "buff_doge", "text0": "Me with Lovable", "text1": "Me learning Cursor", "text2": "", "text3": ""}
```

### 3-Box Templates
Distracted Boyfriend (Vibe series):
```json
{"template": "distracted_boyfriend", "text0": "Developer", "text1": "Bug Fixes", "text2": "New Feature", "text3": ""}
```

### 4-Box Templates
Expanding Brain (Foundation/Level Up series):
```json
{"template": "expanding_brain", "text0": "No Tests", "text1": "Unit Tests", "text2": "Integration Tests", "text3": "E2E Tests"}
```

Gru's Plan (Level Up series):
```json
{"template": "gru_plan", "text0": "Export from Replit", "text1": "Import to Claude Code", "text2": "Keep velocity", "text3": "Keep velocity...?"}
```

**Now extract the meme template and text for the blog content above. Return ONLY the JSON with all 4 text fields:**
